import {
  ApiError,
  authorizedRequest,
  clearAccessToken,
} from "../../../lib/http.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import { isFormSchema } from "../utils/form-schema.validate.ts";

/*
 * Minimal client for the Form API (8.17.11). HTTP, the in-memory access
 * token and the refresh flow live in lib/http.ts and are shared with the
 * auth feature.
 */

export { ApiError, clearAccessToken };

export interface FormRecord {
  id: string;
  name: string;
  status: string;
  /* Untrusted until validated with isFormSchema. */
  draftSchema: unknown;
  /* True once the form has a published version. */
  hasPublishedVersion?: boolean;
}

/* POST /forms/:id/publish response `data` (8.17.13). */
export interface PublishResult {
  formId: string;
  versionId: string;
  version: number;
  status: string;
  publishedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toFormRecord = (body: unknown): FormRecord => {
  const form =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.form)
      ? body.data.form
      : null;

  if (!form || typeof form._id !== "string") {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  return {
    id: form._id,
    name: typeof form.name === "string" ? form.name : "",
    status: typeof form.status === "string" ? form.status : "",
    draftSchema: form.draftSchema,
    // Only present when true, so unpublished records keep their original shape.
    ...(typeof form.publishedVersionId === "string" &&
    form.publishedVersionId !== ""
      ? { hasPublishedVersion: true }
      : {}),
  };
};

export const fetchForm = async (formId: string): Promise<FormRecord> => {
  return toFormRecord(
    await authorizedRequest(`/forms/${encodeURIComponent(formId)}`),
  );
};

/*
 * Saves the one mutable draft of the form. The request body carries ONLY
 * draftSchema; organization, creator and status never come from here.
 */
export const saveFormDraft = async (
  formId: string,
  schema: FormSchema,
): Promise<void> => {
  await authorizedRequest(`/forms/${encodeURIComponent(formId)}`, {
    method: "PATCH",
    body: JSON.stringify({ draftSchema: schema }),
  });
};

/*
 * Publishes the form's SAVED draft as a new immutable version. The request
 * has no body: the server decides what is published. Throws ApiError.
 */
export const publishForm = async (formId: string): Promise<PublishResult> => {
  const body = await authorizedRequest(
    `/forms/${encodeURIComponent(formId)}/publish`,
    { method: "POST" },
  );
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;

  if (
    !data ||
    typeof data.formId !== "string" ||
    typeof data.versionId !== "string" ||
    typeof data.version !== "number" ||
    typeof data.status !== "string" ||
    typeof data.publishedAt !== "string"
  ) {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  return {
    formId: data.formId,
    versionId: data.versionId,
    version: data.version,
    status: data.status,
    publishedAt: data.publishedAt,
  };
};

/* GET /forms/:id/published response `data.published`. */
export interface PublishedFormView {
  formId: string;
  name: string;
  versionId: string;
  version: number;
  /* The immutable published schema, validated before it is returned. */
  schema: FormSchema;
  publishedAt: string;
}

/*
 * Reads the immutable published version (never the draft) for the
 * "Test User" preview. Throws ApiError, e.g. 404 FORM_NOT_PUBLISHED.
 */
export const fetchPublishedForm = async (
  formId: string,
): Promise<PublishedFormView> => {
  const body = await authorizedRequest(
    `/forms/${encodeURIComponent(formId)}/published`,
  );
  const data =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.published)
      ? body.data.published
      : null;

  if (
    !data ||
    typeof data.formId !== "string" ||
    typeof data.name !== "string" ||
    typeof data.versionId !== "string" ||
    typeof data.version !== "number" ||
    typeof data.publishedAt !== "string" ||
    !isFormSchema(data.schema)
  ) {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  return {
    formId: data.formId,
    name: data.name,
    versionId: data.versionId,
    version: data.version,
    schema: data.schema,
    publishedAt: data.publishedAt,
  };
};

/* POST /forms/:id/submissions response `data.submission`. */
export interface SubmissionReceipt {
  id: string;
  formId: string;
  formVersionId: string;
  version: number;
  submittedAt: string;
}

/*
 * Submits values to the form's CURRENT published version. The body is only
 * { data }: the server decides organization, version and submitter. Not
 * used by Preview or the Test User page, which stay local-only. Throws
 * ApiError (400 VALIDATION_ERROR carries per-field messages in `fields`).
 */
export const submitForm = async (
  formId: string,
  data: Record<string, string | boolean>,
): Promise<SubmissionReceipt> => {
  const body = await authorizedRequest(
    `/forms/${encodeURIComponent(formId)}/submissions`,
    { method: "POST", body: JSON.stringify({ data }) },
  );
  const receipt =
    isRecord(body) && isRecord(body.data) && isRecord(body.data.submission)
      ? body.data.submission
      : null;

  if (
    !receipt ||
    typeof receipt.id !== "string" ||
    typeof receipt.formId !== "string" ||
    typeof receipt.formVersionId !== "string" ||
    typeof receipt.version !== "number" ||
    typeof receipt.submittedAt !== "string"
  ) {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  return {
    id: receipt.id,
    formId: receipt.formId,
    formVersionId: receipt.formVersionId,
    version: receipt.version,
    submittedAt: receipt.submittedAt,
  };
};

/* ---------- Creating the form being edited ---------- */

const idOf = (value: unknown): string | null =>
  isRecord(value) && typeof value._id === "string" ? value._id : null;

/*
 * Creates a new draft form for a builder that was opened without one, so
 * Save Draft and Publish have something to save to. It uses the caller's
 * first project (or creates a default one); the organization comes from
 * the session on the server, never from here. Returns the new form id.
 */
export const createDraftForm = async (): Promise<string> => {
  const list = await authorizedRequest("/projects?limit=1");
  const projects =
    isRecord(list) && isRecord(list.data) && Array.isArray(list.data.projects)
      ? list.data.projects
      : [];
  let projectId = idOf(projects[0]);

  if (projectId === null) {
    const created = await authorizedRequest("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "My Project",
        slug: `my-project-${crypto.randomUUID().slice(0, 8)}`,
        status: "ACTIVE",
      }),
    });
    projectId = idOf(
      isRecord(created) && isRecord(created.data) ? created.data.project : null,
    );
  }

  if (projectId === null) {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  const created = await authorizedRequest("/forms", {
    method: "POST",
    body: JSON.stringify({
      name: "Untitled form",
      slug: `untitled-form-${crypto.randomUUID().slice(0, 8)}`,
      status: "draft",
      projectId,
    }),
  });
  const formId = idOf(
    isRecord(created) && isRecord(created.data) ? created.data.form : null,
  );

  if (formId === null) {
    throw new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");
  }

  return formId;
};
