import mongoose from "mongoose";

import { AUDIT_ACTIONS } from "../constants/audit-actions.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import { findFormByIdAndOrganization } from "../repositories/form.repository.js";
import { findFormVersionById } from "../repositories/form-version.repository.js";
import {
  countSubmissions,
  createFormSubmission,
  findSubmissionById,
  listSubmissions,
  type SubmissionListFilter,
} from "../repositories/form-submission.repository.js";
import { findUserNamesByIdsForOrganization } from "../repositories/user.repository.js";
import type { AuthContext } from "../types/auth.types.js";
import { AppError } from "../utils/errors.js";
import { validateSubmissionData } from "../utils/form-submission-validation.util.js";
import {
  MAX_SUBMISSION_BYTES,
  type CreateSubmissionInput,
} from "../validators/form-submission.validator.js";
import {
  DATE_ONLY,
  DEFAULT_SUBMISSION_PAGE_SIZE,
  type ListSubmissionsQuery,
} from "../validators/form-submission.reading.js";

/*
 * Form submission (8.17.15).
 *
 * Tenant scope and submitter come only from AuthContext. The data is
 * validated against the immutable schemaSnapshot of the version the form
 * points to RIGHT NOW (never the draft), and the submission records that
 * exact version. The submission and its audit event are written in one
 * transaction.
 *
 * Missing, other-tenant, archived, unpublished and version-less forms all
 * answer 404, so another tenant's forms are never revealed. The published
 * form cache is not touched: a submission does not change the form.
 */

export interface SubmissionContext {
  ipAddress: string;
  userAgent: string;
}

export interface SubmissionResult {
  id: string;
  formId: string;
  formVersionId: string;
  version: number;
  submittedAt: string;
}

const notPublished = (): AppError =>
  new AppError(404, "FORM_NOT_PUBLISHED", "This form has not been published");

export const submitForm = async (
  auth: AuthContext,
  formId: string,
  input: CreateSubmissionInput,
  context: SubmissionContext,
): Promise<SubmissionResult> => {
  const organizationId = new mongoose.Types.ObjectId(auth.organizationId);
  const userId = new mongoose.Types.ObjectId(auth.userId);
  const id = new mongoose.Types.ObjectId(formId);

  if (Buffer.byteLength(JSON.stringify(input.data), "utf8") > MAX_SUBMISSION_BYTES) {
    throw new AppError(
      413,
      "SUBMISSION_TOO_LARGE",
      "The submission is too large",
    );
  }

  const form = await findFormByIdAndOrganization(id, organizationId);

  if (!form) {
    throw new AppError(404, "FORM_NOT_FOUND", "Form not found");
  }

  if (form.status === "ARCHIVED" || !form.publishedVersionId) {
    throw notPublished();
  }

  const version = await findFormVersionById(
    form.publishedVersionId,
    id,
    organizationId,
  );

  if (!version) {
    throw notPublished();
  }

  const errors = validateSubmissionData(version.schemaSnapshot, input.data);

  if (Object.keys(errors).length > 0) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "The submission is not valid",
      errors,
    );
  }

  const dbSession = await mongoose.startSession();
  let result: SubmissionResult | undefined;

  try {
    await dbSession.withTransaction(async () => {
      const submittedAt = new Date();

      const submission = await createFormSubmission(
        organizationId,
        {
          formId: id,
          formVersionId: version._id,
          version: version.version,
          data: input.data,
          submittedBy: userId,
          submittedAt,
        },
        dbSession,
      );

      // Identifiers only: submitted values may be sensitive.
      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.FORM_SUBMITTED,
          resourceType: "FORM_SUBMISSION",
          resourceId: submission._id,
          metadata: {
            formId: id.toString(),
            formVersionId: version._id.toString(),
            version: version.version,
            submissionId: submission._id.toString(),
          },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );

      result = {
        id: submission._id.toString(),
        formId: id.toString(),
        formVersionId: version._id.toString(),
        version: version.version,
        submittedAt: submittedAt.toISOString(),
      };
    });
  } finally {
    await dbSession.endSession();
  }

  if (!result) {
    throw new Error("Submission finished without a result");
  }

  return result;
};

/* ---------- Reading submissions (8.17.16) ---------- */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubmissionListItem {
  id: string;
  formId: string;
  formVersionId: string;
  version: number;
  submittedBy: string;
  submittedByName: string | null;
  submittedAt: string;
}

export interface SubmissionList {
  items: SubmissionListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

/* Confirms the form belongs to the caller's organization. */
const requireOwnForm = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
) => {
  const form = await findFormByIdAndOrganization(formId, organizationId);

  if (!form) {
    throw new AppError(404, "FORM_NOT_FOUND", "Form not found");
  }

  return form;
};

export const listFormSubmissions = async (
  auth: AuthContext,
  formId: string,
  query: ListSubmissionsQuery,
): Promise<SubmissionList> => {
  const organizationId = new mongoose.Types.ObjectId(auth.organizationId);
  const id = new mongoose.Types.ObjectId(formId);

  await requireOwnForm(organizationId, id);

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_SUBMISSION_PAGE_SIZE;

  // A date-only "to" means the whole day; a date-time is taken exactly.
  const submittedBefore =
    query.submittedTo === undefined
      ? undefined
      : DATE_ONLY.test(query.submittedTo)
        ? new Date(new Date(query.submittedTo).getTime() + DAY_MS)
        : new Date(new Date(query.submittedTo).getTime() + 1);

  const filter: SubmissionListFilter = {
    ...(query.version !== undefined ? { version: query.version } : {}),
    ...(query.submittedFrom !== undefined
      ? { submittedFrom: new Date(query.submittedFrom) }
      : {}),
    ...(submittedBefore !== undefined ? { submittedBefore } : {}),
  };

  const [rows, total] = await Promise.all([
    listSubmissions(organizationId, id, {
      filter,
      order: query.order ?? "desc",
      skip: (page - 1) * pageSize,
      limit: pageSize,
    }),
    countSubmissions(organizationId, id, filter),
  ]);

  const names = await findUserNamesByIdsForOrganization(
    organizationId,
    [...new Set(rows.map((row) => row.submittedBy.toString()))].map(
      (userId) => new mongoose.Types.ObjectId(userId),
    ),
  );

  return {
    items: rows.map((row) => ({
      id: row._id.toString(),
      formId: row.formId.toString(),
      formVersionId: row.formVersionId.toString(),
      version: row.version,
      submittedBy: row.submittedBy.toString(),
      submittedByName: names.get(row.submittedBy.toString()) ?? null,
      submittedAt: row.submittedAt.toISOString(),
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
};

export interface SubmissionDetails {
  id: string;
  formId: string;
  formName: string;
  formVersionId: string;
  version: number;
  data: Record<string, string | boolean>;
  submittedBy: string;
  submittedByName: string | null;
  submittedAt: string;
  /*
   * The schema of the version the submission was made against (from
   * submission.formVersionId, NOT the form's current published version),
   * so labels and types are those of that time. Null only if the version
   * document is unexpectedly missing.
   */
  schema: Record<string, unknown> | null;
}

export const getFormSubmission = async (
  auth: AuthContext,
  formId: string,
  submissionId: string,
): Promise<SubmissionDetails> => {
  const organizationId = new mongoose.Types.ObjectId(auth.organizationId);
  const id = new mongoose.Types.ObjectId(formId);

  const form = await requireOwnForm(organizationId, id);

  const submission = await findSubmissionById(
    organizationId,
    id,
    new mongoose.Types.ObjectId(submissionId),
  );

  if (!submission) {
    throw new AppError(404, "SUBMISSION_NOT_FOUND", "Submission not found");
  }

  const [version, names] = await Promise.all([
    findFormVersionById(submission.formVersionId, id, organizationId),
    findUserNamesByIdsForOrganization(organizationId, [submission.submittedBy]),
  ]);

  return {
    id: submission._id.toString(),
    formId: id.toString(),
    formName: form.name,
    formVersionId: submission.formVersionId.toString(),
    version: submission.version,
    data: submission.data,
    submittedBy: submission.submittedBy.toString(),
    submittedByName: names.get(submission.submittedBy.toString()) ?? null,
    submittedAt: submission.submittedAt.toISOString(),
    schema: version ? structuredClone(version.schemaSnapshot) : null,
  };
};
