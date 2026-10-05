export type FormStatusValue = "DRAFT" | "PUBLISHED" | "ARCHIVED";

/* Anything the server sends that is not a known status reads as Draft. */
export const toFormStatus = (value: string | undefined): FormStatusValue =>
  value === "PUBLISHED" || value === "ARCHIVED" ? value : "DRAFT";

/* The only thing in the preview URL is the form id; the server resolves the rest. */
export const previewPath = (formId: string): string =>
  `/forms/${encodeURIComponent(formId)}/preview`;
