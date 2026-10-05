import mongoose from "mongoose";

import { AUDIT_ACTIONS } from "../constants/audit-actions.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import {
  findFormByIdAndOrganization,
  markFormPublished,
} from "../repositories/form.repository.js";
import {
  createFormVersion,
  findFormVersionById,
  findLatestVersionNumber,
} from "../repositories/form-version.repository.js";
import { invalidatePublishedFormCache } from "../repositories/published-form-cache.repository.js";
import type { AuthContext } from "../types/auth.types.js";
import { canonicalJson } from "../utils/canonical-json.util.js";
import { AppError } from "../utils/errors.js";
import { validateSchemaForPublish } from "../validators/form-publish.validator.js";

/*
 * Publishing (8.17.13).
 *
 * Draft -> validate -> immutable FormVersion -> point the form at it ->
 * audit, all in ONE MongoDB transaction; the published-form cache is
 * invalidated only after that transaction has committed.
 *
 * Tenant scope and user identity come only from AuthContext. The request
 * carries no organization, version or schema: the server publishes the
 * stored draft of a form that belongs to the caller's organization.
 *
 * Concurrency:
 *  - Version numbers are "latest + 1" read inside the transaction. The
 *    unique {organizationId, formId, version} index guarantees a number is
 *    never used twice, and the form update is a compare-and-set on
 *    publishedVersionId, so two racing publishes cannot both succeed:
 *    MongoDB retries the loser (transient write conflict), which then sees
 *    the draft equal to the new published version (FORM_NO_CHANGES), or it
 *    fails with PUBLISH_CONFLICT.
 *  - A draft save racing a publish conflicts on the same form document,
 *    so a publish always snapshots the draft it validated.
 *
 * An unchanged draft (equal to the currently published schema) is rejected
 * with 409 FORM_NO_CHANGES rather than creating an identical version.
 */

export interface PublishContext {
  ipAddress: string;
  userAgent: string;
}

export interface PublishFormResult {
  formId: string;
  versionId: string;
  version: number;
  status: "PUBLISHED";
  publishedAt: string;
}

const DUPLICATE_KEY_ERROR = 11000;

const isDuplicateKeyError = (error: unknown): boolean => {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === DUPLICATE_KEY_ERROR
  );
};

const publishConflict = (): AppError => {
  return new AppError(
    409,
    "PUBLISH_CONFLICT",
    "The form was changed by another publish. Please try again.",
  );
};

export const publishForm = async (
  auth: AuthContext,
  formId: string,
  context: PublishContext,
): Promise<PublishFormResult> => {
  const organizationId = new mongoose.Types.ObjectId(auth.organizationId);
  const userId = new mongoose.Types.ObjectId(auth.userId);
  const id = new mongoose.Types.ObjectId(formId);

  const dbSession = await mongoose.startSession();
  let result: PublishFormResult | undefined;

  try {
    await dbSession.withTransaction(async () => {
      const form = await findFormByIdAndOrganization(
        id,
        organizationId,
        dbSession,
      );

      // Missing and other-tenant forms are indistinguishable.
      if (!form) {
        throw new AppError(404, "FORM_NOT_FOUND", "Form not found");
      }

      if (form.status === "ARCHIVED") {
        throw new AppError(
          409,
          "FORM_ARCHIVED",
          "An archived form cannot be published",
        );
      }

      if (form.draftSchema === undefined || form.draftSchema === null) {
        throw new AppError(
          400,
          "FORM_DRAFT_MISSING",
          "The form has no draft to publish",
        );
      }

      // Validated fresh copy; the stored draft is never modified.
      const schema = validateSchemaForPublish(form.draftSchema);

      const previousVersionId = form.publishedVersionId ?? null;

      if (previousVersionId !== null) {
        const previous = await findFormVersionById(
          previousVersionId,
          id,
          organizationId,
          dbSession,
        );

        if (
          previous &&
          canonicalJson(previous.schemaSnapshot) === canonicalJson(schema)
        ) {
          throw new AppError(
            409,
            "FORM_NO_CHANGES",
            "The draft is identical to the published version",
          );
        }
      }

      const nextVersion =
        (await findLatestVersionNumber(organizationId, id, dbSession)) + 1;
      const publishedAt = new Date();

      const version = await createFormVersion(
        organizationId,
        {
          formId: id,
          version: nextVersion,
          schemaSnapshot: structuredClone(schema) as unknown as Record<
            string,
            unknown
          >,
          settings: {},
          createdBy: userId,
          publishedBy: userId,
          publishedAt,
        },
        dbSession,
      );

      const updated = await markFormPublished(
        id,
        organizationId,
        previousVersionId,
        { publishedVersionId: version._id, updatedBy: userId },
        dbSession,
      );

      if (!updated) {
        throw publishConflict();
      }

      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.FORM_PUBLISHED,
          resourceType: "FORM",
          resourceId: id,
          metadata: {
            formId: id.toString(),
            version: nextVersion,
            versionId: version._id.toString(),
          },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );

      result = {
        formId: id.toString(),
        versionId: version._id.toString(),
        version: nextVersion,
        status: "PUBLISHED",
        publishedAt: publishedAt.toISOString(),
      };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw publishConflict();
    }
    throw error;
  } finally {
    await dbSession.endSession();
  }

  if (!result) {
    throw new Error("Publish finished without a result");
  }

  // After commit only. A failure here must not hide the successful
  // publish, but it is logged: the cache could be stale until it expires.
  try {
    await invalidatePublishedFormCache(organizationId, id);
  } catch (error) {
    console.error(
      "❌ Published-form cache invalidation failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }

  return result;
};
