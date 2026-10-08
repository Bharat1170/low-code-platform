import { ApiError, authorizedRequest } from "../../../lib/http.ts";
import type { FormSchema } from "../../form-builder/types/form-builder.types.ts";
import { isFormSchema } from "../../form-builder/utils/form-schema.validate.ts";

/*
 * Client for reading submissions (8.17.16). Uses the shared HTTP layer
 * (lib/http), so the token, refresh and error handling are the same as
 * everywhere else. Creating submissions lives in forms.api.ts.
 */

export { ApiError };

export interface SubmissionListItem {
  id: string;
  formId: string;
  formVersionId: string;
  version: number;
  submittedBy: string;
  /* Null when the submitter's name is not available. */
  submittedByName: string | null;
  submittedAt: string;
}

export interface SubmissionPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SubmissionList {
  items: SubmissionListItem[];
  pagination: SubmissionPagination;
}

export interface ListSubmissionsParams {
  page?: number;
  pageSize?: number;
  version?: number;
  /* YYYY-MM-DD; "to" includes the whole day. */
  submittedFrom?: string;
  submittedTo?: string;
  order?: "asc" | "desc";
}

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
  /* Schema of the version the submission was made against; null if unavailable. */
  schema: FormSchema | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const invalidResponse = (): ApiError =>
  new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");

const toListItem = (value: unknown): SubmissionListItem => {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.formId) ||
    !isString(value.formVersionId) ||
    typeof value.version !== "number" ||
    !isString(value.submittedBy) ||
    !isString(value.submittedAt)
  ) {
    throw invalidResponse();
  }

  return {
    id: value.id,
    formId: value.formId,
    formVersionId: value.formVersionId,
    version: value.version,
    submittedBy: value.submittedBy,
    submittedByName: isString(value.submittedByName)
      ? value.submittedByName
      : null,
    submittedAt: value.submittedAt,
  };
};

/* Only supported, defined params are sent; everything is URL-encoded. */
export const listSubmissions = async (
  formId: string,
  params: ListSubmissionsParams = {},
): Promise<SubmissionList> => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  const body = await authorizedRequest(
    `/forms/${encodeURIComponent(formId)}/submissions${suffix}`,
  );
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const pagination = data && isRecord(data.pagination) ? data.pagination : null;

  if (
    !data ||
    !Array.isArray(data.items) ||
    !pagination ||
    typeof pagination.page !== "number" ||
    typeof pagination.pageSize !== "number" ||
    typeof pagination.total !== "number" ||
    typeof pagination.totalPages !== "number"
  ) {
    throw invalidResponse();
  }

  return {
    items: data.items.map(toListItem),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      totalPages: pagination.totalPages,
    },
  };
};

export const getSubmission = async (
  formId: string,
  submissionId: string,
): Promise<SubmissionDetails> => {
  const body = await authorizedRequest(
    `/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}`,
  );
  const sub =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.submission)
      ? body.data.submission
      : null;

  if (
    !sub ||
    !isString(sub.id) ||
    !isString(sub.formId) ||
    !isString(sub.formVersionId) ||
    typeof sub.version !== "number" ||
    !isRecord(sub.data) ||
    !isString(sub.submittedBy) ||
    !isString(sub.submittedAt)
  ) {
    throw invalidResponse();
  }

  const data: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(sub.data)) {
    if (isString(value) || typeof value === "boolean") {
      data[key] = value;
    }
  }

  return {
    id: sub.id,
    formId: sub.formId,
    formName: isString(sub.formName) ? sub.formName : "",
    formVersionId: sub.formVersionId,
    version: sub.version,
    data,
    submittedBy: sub.submittedBy,
    submittedByName: isString(sub.submittedByName)
      ? sub.submittedByName
      : null,
    submittedAt: sub.submittedAt,
    // An unreadable schema degrades to "no schema" instead of failing the page.
    schema: isFormSchema(sub.schema) ? sub.schema : null,
  };
};

/*
 * Permanently deletes one submission. Success carries no data; any
 * failure is thrown as an ApiError by the shared HTTP layer.
 */
export const deleteSubmission = async (
  formId: string,
  submissionId: string,
): Promise<void> => {
  await authorizedRequest(
    `/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}`,
    { method: "DELETE" },
  );
};
