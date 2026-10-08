import { useEffect, useRef, useState } from "react";
import { previewPath } from "../utils/form-status.ts";

export const TEST_USER_UNSAVED_MESSAGE =
  "Save the form before testing it as a user.";
export const TEST_USER_SAVE_FAILED_MESSAGE =
  "Your latest changes couldn't be saved, so the preview wasn't opened. Please try again.";
export const TEST_USER_POPUP_MESSAGE =
  "Your browser blocked the preview tab. Allow pop-ups for this site and try again.";

const NOTE_MS = 5000;

/* A tab opened for the preview, navigated once the draft is saved. */
export interface PreviewWindow {
  navigate: (url: string) => void;
  close: () => void;
}

interface TestUserButtonProps {
  /*
   * Saves the editor's latest changes (creating the form first if needed)
   * and resolves the form id, or null when saving failed. Undefined when
   * this builder cannot save at all.
   */
  prepare: (() => Promise<string | null>) | undefined;
  /* Overridable for tests; defaults to a new browser tab. */
  openWindow?: () => PreviewWindow | null;
}

/*
 * The tab must be opened inside the click itself: browsers block
 * window.open() after an await. It starts blank, loses its link back to
 * this page (opener), and is pointed at the preview once the draft is saved.
 */
const openBlankWindow = (): PreviewWindow | null => {
  const win = window.open("", "_blank");

  if (!win) return null;

  return {
    navigate: (url) => {
      win.opener = null;
      win.location.href = url;
    },
    close: () => win.close(),
  };
};

/*
 * Test User: opens the CURRENT DRAFT in a preview tab, the way a person
 * filling the form would see it. It works before publishing. It only saves
 * the draft (like Save Draft); it never publishes and never creates a
 * submission. An unsaved draft is saved first so the preview is current.
 */
export function TestUserButton({
  prepare,
  openWindow = openBlankWindow,
}: TestUserButtonProps) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const showNote = (message: string) => {
    setNote(message);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const handleClick = async () => {
    // A second click before React re-renders must not open a second tab.
    if (busyRef.current) return;

    if (!prepare) {
      showNote(TEST_USER_UNSAVED_MESSAGE);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setNote(null);

    try {
      const target = openWindow();

      if (!target) {
        showNote(TEST_USER_POPUP_MESSAGE);
        return;
      }

      const formId = await prepare();

      if (formId === null) {
        target.close();
        showNote(TEST_USER_SAVE_FAILED_MESSAGE);
        return;
      }

      target.navigate(previewPath(formId));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <span className="fb-test-user">
      <button
        type="button"
        className="fb-button"
        onClick={() => void handleClick()}
        disabled={busy}
        aria-busy={busy}
        aria-describedby={note ? "fb-test-user-note" : undefined}
      >
        Test User
      </button>
      {note && (
        <span
          id="fb-test-user-note"
          className="fb-test-user-note"
          role="status"
        >
          {note}
        </span>
      )}
    </span>
  );
}
