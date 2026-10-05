import type { FormStatusValue } from "../utils/form-status.ts";

const LABELS: Record<FormStatusValue, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

interface FormStatusBadgeProps {
  status: FormStatusValue;
  /* Latest published version number, when known. */
  version?: number | null;
}

/*
 * Read-only indicator of the form's status as reported by the server. It
 * is not a control and decides nothing: authorization and publishing stay
 * on the backend.
 */
export function FormStatusBadge({ status, version }: FormStatusBadgeProps) {
  return (
    <span
      className="fb-form-status"
      data-status={status}
      aria-live="polite"
    >
      <span className="fb-form-status-dot" aria-hidden="true" />
      <span>{LABELS[status]}</span>
      {status === "PUBLISHED" && version != null && (
        <span className="fb-form-status-version">v{version}</span>
      )}
    </span>
  );
}
