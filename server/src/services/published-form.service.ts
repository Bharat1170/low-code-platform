import mongoose from "mongoose";

import {
  findFormByIdAndOrganization,
  findFormByPublicId,
} from "../repositories/form.repository.js";
import { findFormVersionById } from "../repositories/form-version.repository.js";
import {
  readPublishedFormCache,
  writePublishedFormCache,
} from "../repositories/published-form-cache.repository.js";
import type { AuthContext } from "../types/auth.types.js";
import { AppError } from "../utils/errors.js";

/*
 * Read side of publishing (8.17.14): the immutable FormVersion a form
 * currently points to, for the published renderer.
 *
 * Tenant scope comes only from AuthContext (it is also part of the cache
 * key, so another tenant can never hit this tenant's entry). The draft is
 * never read into the response. Only whitelisted fields are returned.
 *
 * Redis is a read-through cache only: MongoDB / FormVersion stays the
 * source of truth, and any Redis failure falls back to MongoDB.
 *
 * A form that is ARCHIVED is not served (same 404 as unpublished). The
 * cache is invalidated by publish and by form updates/deletes, so an
 * archive is visible at once.
 */

export interface PublishedFormView {
  formId: string;
  name: string;
  versionId: string;
  version: number;
  schema: Record<string, unknown>;
  publishedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* Rebuilds the view from a cache entry; anything malformed is a miss. */
const fromCache = (
  value: unknown,
  formId: string,
): PublishedFormView | null => {
  if (
    !isRecord(value) ||
    value.formId !== formId ||
    typeof value.name !== "string" ||
    typeof value.versionId !== "string" ||
    typeof value.version !== "number" ||
    typeof value.publishedAt !== "string" ||
    !isRecord(value.schema)
  ) {
    return null;
  }

  return {
    formId: value.formId,
    name: value.name,
    versionId: value.versionId,
    version: value.version,
    schema: value.schema,
    publishedAt: value.publishedAt,
  };
};

const logCacheFailure = (action: string, error: unknown): void => {
  console.error(
    `❌ Published-form cache ${action} failed:`,
    error instanceof Error ? error.name : "UnknownError",
  );
};

const notPublished = (): AppError =>
  new AppError(404, "FORM_NOT_PUBLISHED", "This form has not been published");

export const getPublishedForm = async (
  auth: AuthContext,
  formId: string,
): Promise<PublishedFormView> =>
  loadPublishedView(
    new mongoose.Types.ObjectId(auth.organizationId),
    new mongoose.Types.ObjectId(formId),
  );

/*
 * What an anonymous visitor of a share link receives: enough to render
 * and submit the current published version, and nothing else (no ids of
 * the form, version, organization or users, no draft, no submissions).
 */
export interface PublicFormView {
  name: string;
  description: string;
  version: number;
  schema: Record<string, unknown>;
}

const publicNotFound = (): AppError =>
  new AppError(404, "FORM_NOT_FOUND", "This form is not available");

export const getPublicForm = async (
  publicId: string,
): Promise<PublicFormView> => {
  const form = await findFormByPublicId(publicId);

  if (!form || form.status === "ARCHIVED" || !form.publishedVersionId) {
    throw publicNotFound();
  }

  let view: PublishedFormView;
  try {
    view = await loadPublishedView(
      form.organizationId,
      form._id as mongoose.Types.ObjectId,
    );
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) {
      throw publicNotFound();
    }
    throw error;
  }

  return {
    name: form.name,
    description: form.description ?? "",
    version: view.version,
    schema: view.schema,
  };
};

/* Cache-backed read of the version a form currently points to. */
const loadPublishedView = async (
  organizationId: mongoose.Types.ObjectId,
  id: mongoose.Types.ObjectId,
): Promise<PublishedFormView> => {
  const normalizedId = id.toString();

  try {
    const cached = fromCache(
      await readPublishedFormCache(organizationId, id),
      normalizedId,
    );

    if (cached) {
      return cached;
    }
  } catch (error) {
    logCacheFailure("read", error);
  }

  const form = await findFormByIdAndOrganization(id, organizationId);

  if (!form) {
    throw new AppError(404, "FORM_NOT_FOUND", "Form not found");
  }

  if (form.status === "ARCHIVED") {
    throw notPublished();
  }

  const version = form.publishedVersionId
    ? await findFormVersionById(form.publishedVersionId, id, organizationId)
    : null;

  if (!version) {
    throw notPublished();
  }

  const view: PublishedFormView = {
    formId: normalizedId,
    name: form.name,
    versionId: version._id.toString(),
    version: version.version,
    schema: structuredClone(version.schemaSnapshot),
    publishedAt: version.publishedAt.toISOString(),
  };

  try {
    await writePublishedFormCache(organizationId, id, view);
  } catch (error) {
    logCacheFailure("write", error);
  }

  return view;
};
