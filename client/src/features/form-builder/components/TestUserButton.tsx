import { useEffect, useRef, useState } from "react";
import { previewPath } from "../utils/form-status.ts";

export const TEST_USER_UNPUBLISHED_MESSAGE =
  "Publish the form before testing it as a user.";

const NOTE_MS = 5000;

interface TestUserButtonProps {
  formId: string | undefined;
  /* The form has a published version. Only controls this button's UX. */
  published: boolean;
  /* Overridable for tests; defaults to a new browser tab. */
  openTab?: (url: string) => void;
}

const openInNewTab = (url: string): void => {
  window.open(url, "_blank", "noopener,noreferrer");
};

/*
 * Opens the published form in a new tab, the way an end user sees it.
 * Read-only: it never saves, publishes or changes the form. An
 * unpublished form is not opened; a message explains why.
 */
export function TestUserButton({
  formId,
  published,
  openTab = openInNewTab,
}: TestUserButtonProps) {
  const [note, setNote] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = () => {
    if (formId === undefined || !published) {
      setNote(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setNote(false), NOTE_MS);
      return;
    }

    setNote(false);
    openTab(previewPath(formId));
  };

  return (
    <span className="fb-test-user">
      <button
        type="button"
        className="fb-button"
        onClick={handleClick}
        aria-describedby={note ? "fb-test-user-note" : undefined}
        data-unavailable={published ? undefined : "true"}
      >
        Test User
      </button>
      {note && (
        <span
          id="fb-test-user-note"
          className="fb-test-user-note"
          role="status"
        >
          {TEST_USER_UNPUBLISHED_MESSAGE}
        </span>
      )}
    </span>
  );
}
