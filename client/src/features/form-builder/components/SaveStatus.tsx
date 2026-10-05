import type { SaveStatus as SaveStatusValue } from "../hooks/useDraftAutosave.ts";

const LABELS: Record<SaveStatusValue, string> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Unable to save",
};

interface SaveStatusProps {
  status: SaveStatusValue;
}

/* Subtle status: a dot plus text, announced politely to screen readers. */
export function SaveStatus({ status }: SaveStatusProps) {
  return (
    <span className="fb-save-status" data-state={status} role="status">
      <span className="fb-save-dot" aria-hidden="true" />
      <span>{LABELS[status]}</span>
    </span>
  );
}
