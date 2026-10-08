import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchPublicId } from "../api/forms.api.ts";
import { publicFormUrl } from "../utils/share-url.ts";
import "../styles/share.css";

export const SHARE_LOAD_FAILED_MESSAGE =
  "We couldn't load the public link. Please try again.";
export const SHARE_NO_LINK_MESSAGE =
  "The public link isn't available yet. Please try again in a moment.";
export const SHARE_COPY_FAILED_MESSAGE =
  "Couldn't copy automatically. Select the link and copy it.";
export const SHARE_LINK_NOTE =
  "Anyone with this link can respond without signing in. Responses appear under Submissions.";

const COPIED_MS = 2000;

interface ShareControlProps {
  formId: string | undefined;
  /* Sharing is only offered for a published form. */
  published: boolean;
  /* Resolves the server-issued publicId (null when there is none). */
  loadPublicId?: (formId: string) => Promise<string | null>;
  /* Overridable for tests. */
  copyText?: (text: string) => Promise<void>;
  openUrl?: (url: string) => void;
}

type LinkState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; url: string };

const copyToClipboard = (text: string): Promise<void> => {
  if (!navigator.clipboard) {
    return Promise.reject(new Error("Clipboard unavailable"));
  }
  return navigator.clipboard.writeText(text);
};

const openInNewTab = (url: string): void => {
  window.open(url, "_blank", "noopener,noreferrer");
};

/*
 * Share button and "Share Form" dialog. Nothing is offered before the form
 * is published. The link uses the server's publicId (fetched through the
 * existing authenticated form API), never the internal form id.
 */
export function ShareControl({
  formId,
  published,
  loadPublicId = fetchPublicId,
  copyText = copyToClipboard,
  openUrl = openInNewTab,
}: ShareControlProps) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<LinkState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const urlRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // A different form (or an unpublished one) never reuses an old link.
  useEffect(() => {
    urlRef.current = null;
  }, [formId]);

  const load = (id: string) => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLink({ kind: "loading" });

    loadPublicId(id)
      .then((publicId) => {
        if (request !== requestRef.current) return;
        if (publicId === null) {
          setLink({ kind: "error", message: SHARE_NO_LINK_MESSAGE });
          return;
        }
        const url = publicFormUrl(publicId);
        urlRef.current = url;
        setLink({ kind: "ready", url });
      })
      .catch(() => {
        if (request === requestRef.current) {
          setLink({ kind: "error", message: SHARE_LOAD_FAILED_MESSAGE });
        }
      });
  };

  const openDialog = () => {
    if (formId === undefined) return;
    setCopied(false);
    setCopyFailed(false);
    setOpen(true);

    if (urlRef.current !== null) {
      setLink({ kind: "ready", url: urlRef.current });
    } else {
      load(formId);
    }
  };

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (open) {
      dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    }
  }, [open]);

  const handleCopy = async () => {
    if (link.kind !== "ready") return;

    try {
      await copyText(link.url);
      setCopyFailed(false);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setCopied(false);
      setCopyFailed(true);
      inputRef.current?.select();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }

    // Keep keyboard focus inside the dialog.
    if (event.key === "Tab" && dialogRef.current) {
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input",
        ),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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

  if (!published || formId === undefined) {
    return null;
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="fb-button"
        onClick={openDialog}
        aria-haspopup="dialog"
      >
        Share
      </button>

      {open && (
        <div className="fb-dialog-backdrop">
          <div
            ref={dialogRef}
            className="fb-dialog fb-share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-share-title"
            onKeyDown={handleKeyDown}
          >
            <h2 id="fb-share-title" className="fb-dialog-title">
              Share Form
            </h2>
            <p className="fb-dialog-text">
              Anyone with this link can open your published form without
              signing in.
            </p>

            {link.kind === "loading" && (
              <p className="fb-share-status" role="status">
                Loading link…
              </p>
            )}

            {link.kind === "error" && (
              <div className="fb-dialog-error" role="alert">
                <p>{link.message}</p>
              </div>
            )}

            {link.kind === "ready" && (
              <>
                <label className="fb-share-label" htmlFor="fb-share-url">
                  Public URL
                </label>
                <input
                  ref={inputRef}
                  id="fb-share-url"
                  className="fb-control fb-share-url"
                  type="text"
                  readOnly
                  value={link.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
                {copyFailed && (
                  <p className="fb-share-copy-failed" role="alert">
                    {SHARE_COPY_FAILED_MESSAGE}
                  </p>
                )}
                <p className="fb-share-note">{SHARE_LINK_NOTE}</p>
              </>
            )}

            <div className="fb-dialog-actions">
              {link.kind === "error" && (
                <button type="button" className="fb-button" onClick={() => load(formId)}>
                  Try again
                </button>
              )}
              {link.kind === "ready" && (
                <>
                  <button
                    type="button"
                    className="fb-button"
                    onClick={() => openUrl(link.url)}
                  >
                    Open Form
                  </button>
                  <button
                    type="button"
                    className="fb-button fb-button-primary"
                    onClick={() => void handleCopy()}
                  >
                    {copied ? "Copied!" : "Copy Link"}
                  </button>
                </>
              )}
              <button type="button" className="fb-button" onClick={close}>
                Close
              </button>
            </div>

            <span className="fb-share-live" aria-live="polite">
              {copied ? "Link copied to clipboard" : ""}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
