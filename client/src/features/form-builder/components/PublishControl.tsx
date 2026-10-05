import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, type PublishResult } from "../api/forms.api.ts";

interface PublishControlProps {
  formId: string | undefined;
  /* The draft on the server matches the editor (nothing unsaved). */
  draftSaved: boolean;
  /* The form already has a published version (known when it was loaded). */
  initiallyPublished: boolean;
  publish: (formId: string) => Promise<PublishResult>;
  /* Called after the API confirmed the publish. */
  onPublished?: (result: PublishResult) => void;
  /* Render the "Published" badge here (the builder renders its own). */
  showBadge?: boolean;
  /* An archived form cannot be published. */
  archived?: boolean;
  /* The saved draft equals what was just published (nothing new to publish). */
  unchangedSincePublish?: boolean;
  /*
   * Saves the editor's latest changes (creating the form first if needed)
   * and resolves the form id, or null if saving failed. When given, the
   * button no longer waits for a manual save: publishing saves first and
   * never publishes a stale draft. A running save also disables it.
   */
  ensureSaved?: () => Promise<string | null>;
  saving?: boolean;
}

export const SAVE_FIRST_MESSAGE = "Save your latest changes before publishing.";

const SAVE_FAILED_MESSAGE =
  "Your latest changes couldn't be saved, so nothing was published. Your edits are kept; please try again.";

interface PublishFailure {
  message: string;
  issues: string[];
}

/* "fields.2.label" -> "Field 3: ..." so people can find the problem. */
const describeIssues = (fields: Record<string, string>): string[] =>
  Object.entries(fields).map(([path, message]) => {
    const match = /^fields\.(\d+)\./.exec(path);
    return match ? `Field ${Number(match[1]) + 1}: ${message}` : message;
  });

const toFailure = (error: unknown): PublishFailure => {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "FORM_SCHEMA_INVALID":
        return {
          message: "This form can't be published yet. Fix the following and try again.",
          issues: describeIssues(error.fields),
        };
      case "FORM_NO_CHANGES":
        return {
          message: "There are no changes since the last published version.",
          issues: [],
        };
      case "PUBLISH_CONFLICT":
        return {
          message: "The form was published by someone else at the same time. Please try again.",
          issues: [],
        };
      case "FORM_ARCHIVED":
        return { message: "An archived form can't be published.", issues: [] };
      case "FORM_DRAFT_MISSING":
        return { message: "Save the form before publishing it.", issues: [] };
    }

    if (error.status === 0) {
      return {
        message: "We couldn't reach the server. Your draft is safe; please try again.",
        issues: [],
      };
    }
    if (error.status === 401) {
      return { message: "Your session has expired. Please sign in again.", issues: [] };
    }
    if (error.status === 403) {
      return { message: "You don't have permission to publish this form.", issues: [] };
    }
    if (error.status === 404) {
      return { message: "This form no longer exists.", issues: [] };
    }
    if (error.status === 429) {
      return { message: "Too many requests. Please wait a moment and try again.", issues: [] };
    }
  }

  return {
    message: "Publishing failed. Your draft is unchanged; please try again.",
    issues: [],
  };
};

/*
 * Publish button, confirmation dialog and "Published · Version N" badge.
 * Success is only shown after the API confirms it. The editor's draft is
 * never touched here, so a failed publish loses nothing.
 */
export function PublishControl({
  formId,
  draftSaved,
  initiallyPublished,
  publish,
  onPublished,
  showBadge = true,
  archived = false,
  unchangedSincePublish = false,
  ensureSaved,
  saving = false,
}: PublishControlProps) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"saving" | "publishing" | null>(null);
  const publishing = stage !== null;
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [published, setPublished] = useState<PublishResult | null>(null);
  const [wasPublished, setWasPublished] = useState(initiallyPublished);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  // Without ensureSaved the draft must already be saved; with it,
  // publishing saves first, so only real in-progress work blocks it.
  const hasTarget = formId !== undefined || ensureSaved !== undefined;
  const canPublish =
    hasTarget &&
    (ensureSaved !== undefined ? !saving : draftSaved) &&
    !publishing &&
    !archived &&
    !unchangedSincePublish;

  const close = () => {
    if (inFlightRef.current) return;
    setOpen(false);
    setFailure(null);
    triggerRef.current?.focus();
  };

  const confirm = async () => {
    // Guards against a second click before React re-renders.
    if (inFlightRef.current || (formId === undefined && !ensureSaved)) return;

    inFlightRef.current = true;
    setStage(ensureSaved ? "saving" : "publishing");
    setFailure(null);

    try {
      let targetId = formId;

      if (ensureSaved) {
        const savedId = await ensureSaved();

        if (savedId === null) {
          if (mountedRef.current) {
            setFailure({ message: SAVE_FAILED_MESSAGE, issues: [] });
          }
          return;
        }

        targetId = savedId;
        if (mountedRef.current) setStage("publishing");
      }

      const result = await publish(targetId as string);

      if (mountedRef.current) {
        setPublished(result);
        setWasPublished(true);
        setOpen(false);
        onPublished?.(result);
      }
    } catch (error) {
      if (mountedRef.current) {
        setFailure(toFailure(error));
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setStage(null);
      }
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
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

  const title = !hasTarget
    ? "Open a saved form to publish it"
    : archived
      ? "An archived form can't be published"
      : !draftSaved && ensureSaved === undefined
        ? SAVE_FIRST_MESSAGE
        : unchangedSincePublish
          ? "There are no changes since the last published version"
          : undefined;

  return (
    <>
      {showBadge && wasPublished && (
        <span className="fb-published" role="status" data-state="published">
          <span className="fb-published-dot" aria-hidden="true" />
          {published ? `Published · Version ${published.version}` : "Published"}
        </span>
      )}

      <button
        ref={triggerRef}
        type="button"
        className="fb-button fb-button-primary"
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
        disabled={!canPublish}
        aria-busy={publishing}
        title={title}
        data-stage={stage ?? undefined}
      >
        Publish
      </button>

      {open && (
        <div className="fb-dialog-backdrop">
          <div
            className="fb-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-publish-title"
            aria-describedby="fb-publish-desc"
            onKeyDown={handleDialogKeyDown}
          >
            <h2 id="fb-publish-title" className="fb-dialog-title">
              Publish this form?
            </h2>
            <p id="fb-publish-desc" className="fb-dialog-text">
              Publishing saves your latest changes first, then makes the draft
              available as a new, immutable version. Published versions can&apos;t be edited; you can
              keep editing the draft and publish again later.
            </p>

            {failure && (
              <div className="fb-dialog-error" role="alert">
                <p>{failure.message}</p>
                {failure.issues.length > 0 && (
                  <ul>
                    {failure.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="fb-dialog-actions">
              <button
                ref={cancelRef}
                type="button"
                className="fb-button"
                onClick={close}
                disabled={publishing}
              >
                Cancel
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="fb-button fb-button-primary"
                onClick={() => void confirm()}
                disabled={publishing}
                aria-busy={publishing}
              >
                {stage === "saving"
                  ? "Saving draft..."
                  : stage === "publishing"
                    ? "Publishing..."
                    : "Publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
