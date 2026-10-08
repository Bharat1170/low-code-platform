import type { FormFieldDefinition } from "../../form-builder/types/form-builder.types.ts";
import { ApiError } from "../api/submissions.api.ts";

/* Last 8 characters: short enough to scan, still distinguishable. */
export const shortId = (id: string): string => id.slice(-8);

export const formatDateTime = (iso: string): string => {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/* Safe, user-facing text; never the backend's own message. */
export const submissionsErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again.";
    if (error.status === 403) {
      return "You don't have permission to view submissions for this form.";
    }
    if (error.status === 404) return "This form or submission was not found.";
    if (error.status === 400) return "Those filters aren't valid. Please check them and try again.";
    if (error.status === 429) return "Too many requests. Please wait a moment and try again.";
  }

  return "Unable to load submissions. Please try again.";
};

/* A submitted value as text. Never markup. */
export const displayValue = (
  field: FormFieldDefinition | undefined,
  value: string | boolean | undefined,
): string => {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === "") return "—";

  if (field?.type === "DROPDOWN" && Array.isArray(field.config?.options)) {
    const option = field.config.options.find((o) => o.value === value);
    if (option && option.label !== option.value) {
      return `${option.label} (${value})`;
    }
  }

  return value;
};

export const FIELD_TYPE_LABELS: Record<string, string> = {
  TEXT: "Text",
  EMAIL: "Email",
  DROPDOWN: "Dropdown",
  CHECKBOX: "Checkbox",
  DATE: "Date",
};

/* Safe, user-facing text for a failed delete; never the backend's message. */
export const deleteErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again.";
    if (error.status === 403) {
      return "You don't have permission to delete submissions for this form.";
    }
    if (error.status === 404) return "This submission no longer exists.";
    if (error.status === 429) return "Too many requests. Please wait a moment and try again.";
    if (error.status === 0) {
      return "Unable to reach the server. Check your connection and try again.";
    }
  }

  return "Unable to delete the submission. Please try again.";
};
