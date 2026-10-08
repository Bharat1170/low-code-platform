import { useId, useRef, useState, type KeyboardEvent } from "react";

export const MAX_FORM_NAME = 150;
export const MAX_FORM_DESCRIPTION = 500;

export interface FormDetails {
  name: string;
  description: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

interface FormDetailsEditorProps {
  initialName: string;
  initialDescription: string;
  /* Persists name + description; rejects on failure. */
  onSave: (details: FormDetails) => Promise<void>;
  /* Nothing can be saved (e.g. a builder without a form). */
  disabled?: boolean;
}

/*
 * Inline title and description of the form, shown at the top of the
 * canvas. Changes are saved when a field loses focus (or on Enter in the
 * title); Escape restores the last saved value. The respondent sees both
 * on the public page.
 */
export function FormDetailsEditor({
  initialName,
  initialDescription,
  onSave,
  disabled = false,
}: FormDetailsEditorProps) {
  const nameId = useId();
  const descriptionId = useId();
  const statusId = useId();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<FormDetails>({
    name: initialName,
    description: initialDescription,
  });
  const inFlight = useRef(false);

  const commit = async () => {
    const next = { name: name.trim(), description: description.trim() };

    if (next.name === "") {
      setError("The form needs a name.");
      setState("error");
      return;
    }
    if (
      disabled ||
      inFlight.current ||
      (next.name === saved.current.name &&
        next.description === saved.current.description)
    ) {
      return;
    }

    inFlight.current = true;
    setState("saving");
    setError(null);

    try {
      await onSave(next);
      saved.current = next;
      setName(next.name);
      setDescription(next.description);
      setState("saved");
    } catch {
      setError("Couldn't save the name and description. Please try again.");
      setState("error");
    } finally {
      inFlight.current = false;
    }
  };

  const revert = () => {
    setName(saved.current.name);
    setDescription(saved.current.description);
    setError(null);
    setState("idle");
  };

  const onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      revert();
    }
  };

  return (
    <div className="fb-details">
      <label className="fb-sr-only" htmlFor={nameId}>
        Form name
      </label>
      <input
        id={nameId}
        className="fb-details-name"
        type="text"
        value={name}
        maxLength={MAX_FORM_NAME}
        placeholder="Untitled form"
        disabled={disabled}
        aria-invalid={state === "error" && name.trim() === "" ? true : undefined}
        aria-describedby={statusId}
        onChange={(event) => {
          setName(event.target.value);
          if (state === "saved") setState("idle");
        }}
        onBlur={() => void commit()}
        onKeyDown={onNameKey}
      />
      <label className="fb-sr-only" htmlFor={descriptionId}>
        Form description
      </label>
      <textarea
        id={descriptionId}
        className="fb-details-description"
        rows={1}
        value={description}
        maxLength={MAX_FORM_DESCRIPTION}
        placeholder="Add a description for respondents (optional)"
        disabled={disabled}
        aria-describedby={statusId}
        onChange={(event) => {
          setDescription(event.target.value);
          if (state === "saved") setState("idle");
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Escape") revert();
        }}
      />
      <p id={statusId} className="fb-details-status" data-state={state} aria-live="polite">
        {state === "saving"
          ? "Saving…"
          : state === "saved"
            ? "Name and description saved"
            : state === "error"
              ? error
              : ""}
      </p>
    </div>
  );
}
