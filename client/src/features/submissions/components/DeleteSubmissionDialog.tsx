import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, deleteSubmission } from "../api/submissions.api.ts";
import { deleteErrorMessage } from "../utils/submissions.format.ts";
import "../../form-builder/styles/form-builder.css";
import "../styles/submissions.css";

interface DeleteSubmissionDialogProps {
  formId: string;
  submissionId: string;
  /* Short label shown in the confirmation text. */
  label: string;
  onClose: () => void;
  /* Called once the submission is gone (deleted, or already missing). */
  onDeleted: (outcome: "deleted" | "already-gone") => void;
}

/*
 * Confirmation for permanently deleting one submission. The request is
 * sent once: the buttons are disabled while it runs. A 404 means the
 * submission is already gone, so it is treated as done. Other failures
 * stay in the dialog so the user can retry or cancel.
 */
export function DeleteSubmissionDialog({
  formId,
  submissionId,
  label,
  onClose,
  onDeleted,
}: DeleteSubmissionDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDeleting(true);
    setError(null);

    try {
      await deleteSubmission(formId, submissionId);
      onDeleted("deleted");
    } catch (failure: unknown) {
      if (failure instanceof ApiError && failure.status === 404) {
        onDeleted("already-gone");
        return;
      }
      setError(deleteErrorMessage(failure));
      inFlight.current = false;
      setDeleting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!deleting) onClose();
      return;
    }

    // Keep keyboard focus inside the dialog.
    if (event.key === "Tab") {
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fb-dialog-backdrop">
      <div
        className="fb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sub-delete-title"
        aria-describedby="sub-delete-desc"
        onKeyDown={handleKeyDown}
      >
        <h2 id="sub-delete-title" className="fb-dialog-title">
          Delete this submission?
        </h2>
        <p id="sub-delete-desc" className="fb-dialog-text">
          Submission {label} will be permanently deleted. This action cannot be
          undone.
        </p>

        {error && (
          <div className="fb-dialog-error" role="alert">
            <p>{error}</p>
          </div>
        )}

        <div className="fb-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="fb-button"
            onClick={onClose}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="fb-button sub-danger"
            onClick={() => void confirm()}
            disabled={deleting}
            aria-busy={deleting}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
