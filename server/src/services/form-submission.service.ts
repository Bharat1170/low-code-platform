import mongoose from "mongoose";

import { AUDIT_ACTIONS } from "../constants/audit-actions.js";
import { createAuditLog } from "../repositories/audit-log.repository.js";
import {
  findFormByIdAndOrganization,
  findFormByPublicId,
} from "../repositories/form.repository.js";
import {
  findFormVersionById,
  findFormVersionsByIds,
} from "../repositories/form-version.repository.js";
import {
  countSubmissions,
  createFormSubmission,
  deleteSubmissionById,
  findSubmissionById,
  listSubmissions,
  listSubmissionsForExport,
  type SubmissionListFilter,
} from "../repositories/form-submission.repository.js";
import { findUserNamesByIdsForOrganization } from "../repositories/user.repository.js";
import type { AuthContext } from "../types/auth.types.js";
import { toCsv } from "../utils/csv.util.js";
import { AppError } from "../utils/errors.js";
import { validateSubmissionData } from "../utils/form-submission-validation.util.js";
import {
  MAX_SUBMISSION_BYTES,
  type CreateSubmissionInput,
  type SubmissionData,
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

/*
 * The one submission path. organizationId and formId are already
 * resolved by the caller from server-side state (the session, or the
 * form a publicId points to); userId is null for an anonymous submitter.
 */
const submitToForm = async (
  organizationId: mongoose.Types.ObjectId,
  id: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId | null,
  input: CreateSubmissionInput,
  context: SubmissionContext,
): Promise<SubmissionResult> => {

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

export const submitForm = async (
  auth: AuthContext,
  formId: string,
  input: CreateSubmissionInput,
  context: SubmissionContext,
): Promise<SubmissionResult> =>
  submitToForm(
    new mongoose.Types.ObjectId(auth.organizationId),
    new mongoose.Types.ObjectId(formId),
    new mongoose.Types.ObjectId(auth.userId),
    input,
    context,
  );

/* What an anonymous respondent learns: that it worked, and when. */
export interface PublicSubmissionResult {
  submittedAt: string;
}

/*
 * Anonymous submission through a share link. The publicId is the only
 * input that selects the form; organization, form, version and submitter
 * are all derived here, never read from the request. Unknown, archived
 * and unpublished forms are indistinguishable (404).
 */
export const submitPublicForm = async (
  publicId: string,
  input: CreateSubmissionInput,
  context: SubmissionContext,
): Promise<PublicSubmissionResult> => {
  if (Buffer.byteLength(JSON.stringify(input.data), "utf8") > MAX_SUBMISSION_BYTES) {
    throw new AppError(413, "SUBMISSION_TOO_LARGE", "The submission is too large");
  }

  const form = await findFormByPublicId(publicId);

  if (!form || form.status === "ARCHIVED" || !form.publishedVersionId) {
    throw publicFormNotFound();
  }

  try {
    const result = await submitToForm(
      form.organizationId,
      form._id as mongoose.Types.ObjectId,
      null,
      input,
      context,
    );
    return { submittedAt: result.submittedAt };
  } catch (error) {
    // Same answer for every way the form can be unavailable.
    if (
      error instanceof AppError &&
      (error.code === "FORM_NOT_FOUND" || error.code === "FORM_NOT_PUBLISHED")
    ) {
      throw publicFormNotFound();
    }
    throw error;
  }
};

export const publicFormNotFound = (): AppError =>
  new AppError(404, "FORM_NOT_FOUND", "This form is not available");

/* ---------- Reading submissions (8.17.16) ---------- */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubmissionListItem {
  id: string;
  formId: string;
  formVersionId: string;
  version: number;
  /* Null for an anonymous (public link) submission. */
  submittedBy: string | null;
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
    [
      ...new Set(
        rows.flatMap((row) => (row.submittedBy ? [row.submittedBy.toString()] : [])),
      ),
    ].map(
      (userId) => new mongoose.Types.ObjectId(userId),
    ),
  );

  return {
    items: rows.map((row) => ({
      id: row._id.toString(),
      formId: row.formId.toString(),
      formVersionId: row.formVersionId.toString(),
      version: row.version,
      submittedBy: row.submittedBy ? row.submittedBy.toString() : null,
      submittedByName: row.submittedBy
        ? (names.get(row.submittedBy.toString()) ?? null)
        : null,
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
  data: SubmissionData;
  submittedBy: string | null;
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
    findUserNamesByIdsForOrganization(
      organizationId,
      submission.submittedBy ? [submission.submittedBy] : [],
    ),
  ]);

  return {
    id: submission._id.toString(),
    formId: id.toString(),
    formName: form.name,
    formVersionId: submission.formVersionId.toString(),
    version: submission.version,
    data: submission.data,
    submittedBy: submission.submittedBy ? submission.submittedBy.toString() : null,
    submittedByName: submission.submittedBy
      ? (names.get(submission.submittedBy.toString()) ?? null)
      : null,
    submittedAt: submission.submittedAt.toISOString(),
    schema: version ? structuredClone(version.schemaSnapshot) : null,
  };
};

/* ---------- Exporting submissions ---------- */

export const MAX_EXPORT_ROWS = 10_000;

export interface SubmissionExport {
  filename: string;
  csv: string;
  /* More submissions exist than were exported. */
  truncated: boolean;
}

const exportValue = (value: SubmissionData[string] | undefined): string => {
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join("; ");
  return value;
};

/*
 * CSV of a form's submissions, newest first. Columns are the fields of
 * every version the exported rows used (newest version's order first),
 * labelled from those immutable versions, so renamed or removed fields of
 * older versions are still exported. Values are never interpreted.
 */
export const exportFormSubmissions = async (
  auth: AuthContext,
  formId: string,
  context: SubmissionContext,
): Promise<SubmissionExport> => {
  const organizationId = new mongoose.Types.ObjectId(auth.organizationId);
  const id = new mongoose.Types.ObjectId(formId);

  const form = await requireOwnForm(organizationId, id);

  const rows = await listSubmissionsForExport(
    organizationId,
    id,
    MAX_EXPORT_ROWS + 1,
  );
  const truncated = rows.length > MAX_EXPORT_ROWS;
  const exported = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

  const versionIds = [
    ...new Set(exported.map((row) => row.formVersionId.toString())),
  ].map((value) => new mongoose.Types.ObjectId(value));

  const submitterIds = [
    ...new Set(
      exported.flatMap((row) => (row.submittedBy ? [row.submittedBy.toString()] : [])),
    ),
  ].map((value) => new mongoose.Types.ObjectId(value));

  const [versions, names] = await Promise.all([
    findFormVersionsByIds(versionIds, id, organizationId),
    findUserNamesByIdsForOrganization(organizationId, submitterIds),
  ]);

  // Field id -> label, in first-seen order across versions (newest first).
  const columns = new Map<string, string>();
  for (const version of versions) {
    const fields = Array.isArray(version.schemaSnapshot?.fields)
      ? (version.schemaSnapshot.fields as unknown[])
      : [];

    for (const field of fields) {
      if (
        typeof field === "object" &&
        field !== null &&
        typeof (field as { id?: unknown }).id === "string" &&
        !columns.has((field as { id: string }).id)
      ) {
        const { id: fieldId, label } = field as { id: string; label?: unknown };
        columns.set(
          fieldId,
          typeof label === "string" && label.trim() !== "" ? label.trim() : fieldId,
        );
      }
    }
  }

  const fieldIds = [...columns.keys()];
  const csv = toCsv([
    ["Submitted at", "Version", "Submitted by", ...columns.values()],
    ...exported.map((row) => [
      row.submittedAt.toISOString(),
      String(row.version),
      row.submittedBy
        ? (names.get(row.submittedBy.toString()) ?? "Unknown user")
        : "Anonymous",
      ...fieldIds.map((fieldId) =>
        exportValue((row.data as SubmissionData)[fieldId]),
      ),
    ]),
  ]);

  // A bulk read of possibly sensitive answers: recorded, ids only.
  await createAuditLog({
    organizationId,
    userId: new mongoose.Types.ObjectId(auth.userId),
    action: AUDIT_ACTIONS.SUBMISSIONS_EXPORTED,
    resourceType: "FORM",
    resourceId: id,
    metadata: { formId: id.toString(), rows: exported.length, truncated },
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  const safeName =
    form.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "form";

  return {
    filename: `${safeName}-submissions.csv`,
    csv,
    truncated,
  };
};

/* ---------- Deleting a submission ---------- */

/*
 * Hard delete. The submission and its audit event commit together; the
 * audit event records identifiers only, never the submitted values. A
 * submission of another tenant or another form is reported as 404.
 */
export const deleteFormSubmission = async (
  auth: AuthContext,
  formId: string,
  submissionId: string,
  context: SubmissionContext,
): Promise<void> => {
  const organizationId = new mongoose.Types.ObjectId(auth.organizationId);
  const userId = new mongoose.Types.ObjectId(auth.userId);
  const id = new mongoose.Types.ObjectId(formId);
  const targetId = new mongoose.Types.ObjectId(submissionId);

  await requireOwnForm(organizationId, id);

  const dbSession = await mongoose.startSession();
  let deleted = false;

  try {
    await dbSession.withTransaction(async () => {
      const removed = await deleteSubmissionById(
        organizationId,
        id,
        targetId,
        dbSession,
      );

      deleted = removed !== null;

      if (!removed) {
        return;
      }

      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.SUBMISSION_DELETED,
          resourceType: "FORM_SUBMISSION",
          resourceId: removed._id,
          metadata: {
            formId: id.toString(),
            formVersionId: removed.formVersionId.toString(),
            version: removed.version,
            submissionId: removed._id.toString(),
          },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );
    });
  } finally {
    await dbSession.endSession();
  }

  if (!deleted) {
    throw new AppError(404, "SUBMISSION_NOT_FOUND", "Submission not found");
  }
};
