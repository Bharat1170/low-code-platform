import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  FormFieldDefinition,
  FormSchema,
} from "../../form-builder/types/form-builder.types.ts";
import type {
  FieldErrors,
  FieldValue,
  FieldValues,
  FormRendererMode,
  FormSubmitHandler,
} from "../types/form-renderer.types.ts";
import {
  defaultValueFor,
  dropdownOptions,
  fieldLabel,
  isRequired,
  isSupportedField,
  ratingScale,
  validateForm,
} from "../utils/form-validation.ts";
import "../styles/form-renderer.css";

interface FormRendererProps {
  schema: FormSchema;
  mode: FormRendererMode;
  /*
   * When given, a valid submit sends the values through it (the caller
   * decides where). Without it the renderer only validates locally and
   * shows a local confirmation, as in the builder preview.
   */
  onSubmit?: FormSubmitHandler;
  /* Extra actions shown next to "Submit another response" after success. */
  successActions?: ReactNode;
}

/*
 * The one rendering engine for a FormSchema. It only reads the schema and
 * keeps what the person types (values, touched, submitted) in its own
 * state, so it can never change the schema, autosave, publish or submit
 * anything. Labels, descriptions and options are rendered as text.
 *
 * Without onSubmit, submitting validates locally and shows a local
 * confirmation only; nothing is persisted. With onSubmit, a valid submit is
 * handed to it, and the result (success, or a message plus optional
 * per-field errors from the server) is shown here.
 */

interface FieldViewProps {
  field: FormFieldDefinition;
  value: FieldValue;
  error: string | undefined;
  readOnly: boolean;
  onChange: (fieldId: string, value: FieldValue) => void;
  onBlur: (fieldId: string) => void;
}

const placeholderOf = (field: FormFieldDefinition): string => {
  const config: unknown = field.config;
  const placeholder =
    typeof config === "object" && config !== null
      ? (config as { placeholder?: unknown }).placeholder
      : undefined;
  return typeof placeholder === "string" ? placeholder : "";
};

function FieldView({
  field,
  value,
  error,
  readOnly,
  onChange,
  onBlur,
}: FieldViewProps) {
  const controlId = `fr-${field.id}`;
  const descriptionId = field.description ? `${controlId}-desc` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy =
    [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  const required = isRequired(field);

  const labelText = (
    <>
      {fieldLabel(field)}
      {required && (
        <>
          <span className="fr-required" aria-hidden="true">
            *
          </span>
          <span className="fr-sr-only"> (required)</span>
        </>
      )}
    </>
  );

  const label = (
    <label className="fr-label" htmlFor={controlId}>
      {labelText}
    </label>
  );

  const text = typeof value === "string" ? value : "";
  const chosen = Array.isArray(value) ? value : [];

  /* A radio-style group; the fieldset carries the id so errors can focus it. */
  const group = (children: ReactNode, className = "fr-choices") => (
    <fieldset
      id={controlId}
      className={`fr-group ${className}`}
      tabIndex={-1}
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      aria-required={required ? true : undefined}
      disabled={readOnly}
    >
      <legend className="fr-label">{labelText}</legend>
      {children}
    </fieldset>
  );

  const common = {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
    "aria-required": required ? true : undefined,
    onBlur: () => onBlur(field.id),
  };

  let control;
  switch (field.type) {
    case "TEXT":
    case "EMAIL":
      control = (
        <input
          {...common}
          className="fb-control"
          type={field.type === "EMAIL" ? "email" : "text"}
          value={typeof value === "string" ? value : ""}
          placeholder={placeholderOf(field)}
          readOnly={readOnly}
          autoComplete={field.type === "EMAIL" ? "email" : "off"}
          onChange={(event) => onChange(field.id, event.target.value)}
        />
      );
      break;

    case "TEXTAREA":
      control = (
        <textarea
          {...common}
          className="fb-control fr-textarea"
          rows={4}
          value={text}
          placeholder={placeholderOf(field)}
          readOnly={readOnly}
          onChange={(event) => onChange(field.id, event.target.value)}
        />
      );
      break;

    case "NUMBER":
    case "PHONE":
    case "URL":
      control = (
        <input
          {...common}
          className="fb-control"
          type={field.type === "PHONE" ? "tel" : field.type === "URL" ? "url" : "text"}
          inputMode={
            field.type === "NUMBER" ? "decimal" : field.type === "PHONE" ? "tel" : "url"
          }
          value={text}
          placeholder={placeholderOf(field)}
          readOnly={readOnly}
          autoComplete={field.type === "PHONE" ? "tel" : field.type === "URL" ? "url" : "off"}
          onChange={(event) => onChange(field.id, event.target.value)}
        />
      );
      break;

    case "RADIO":
      control = group(
        dropdownOptions(field).map((option) => (
          <label className="fr-choice" key={option.value}>
            <input
              type="radio"
              name={controlId}
              value={option.value}
              checked={text === option.value}
              onChange={() => onChange(field.id, option.value)}
              onBlur={() => onBlur(field.id)}
            />
            <span>{option.label}</span>
          </label>
        )),
      );
      break;

    case "MULTI_SELECT":
      control = group(
        dropdownOptions(field).map((option) => (
          <label className="fr-choice" key={option.value}>
            <input
              type="checkbox"
              value={option.value}
              checked={chosen.includes(option.value)}
              onChange={(event) =>
                onChange(
                  field.id,
                  event.target.checked
                    ? [...chosen, option.value]
                    : chosen.filter((item) => item !== option.value),
                )
              }
              onBlur={() => onBlur(field.id)}
            />
            <span>{option.label}</span>
          </label>
        )),
      );
      break;

    case "RATING": {
      const scale = ratingScale(field);
      const current = Number(text) || 0;
      control = group(
        Array.from({ length: scale }, (_, index) => index + 1).map((star) => (
          <label className="fr-star" key={star} data-on={star <= current ? "true" : undefined}>
            <input
              type="radio"
              className="fr-sr-only"
              name={controlId}
              value={String(star)}
              checked={current === star}
              onChange={() => onChange(field.id, String(star))}
              onBlur={() => onBlur(field.id)}
            />
            <span aria-hidden="true">★</span>
            <span className="fr-sr-only">
              {star} of {scale}
            </span>
          </label>
        )),
        "fr-rating",
      );
      break;
    }

    case "DROPDOWN":
      control = (
        <select
          {...common}
          className="fb-control fb-control-select"
          value={typeof value === "string" ? value : ""}
          disabled={readOnly}
          onChange={(event) => onChange(field.id, event.target.value)}
        >
          <option value="">{placeholderOf(field) || "Select an option"}</option>
          {dropdownOptions(field).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;

    case "DATE":
      control = (
        <input
          {...common}
          className="fb-control"
          type="date"
          value={typeof value === "string" ? value : ""}
          min={field.validation?.minDate}
          max={field.validation?.maxDate}
          readOnly={readOnly}
          onChange={(event) => onChange(field.id, event.target.value)}
        />
      );
      break;

    case "CHECKBOX":
      control = (
        <input
          {...common}
          className="fb-checkbox"
          type="checkbox"
          checked={value === true}
          disabled={readOnly}
          onChange={(event) => onChange(field.id, event.target.checked)}
        />
      );
      break;
  }

  return (
    <div
      className="fr-field"
      data-field-type={field.type}
      data-invalid={error ? "true" : undefined}
    >
      {field.type === "CHECKBOX" ? (
        <div className="fr-field-checkbox">
          {control}
          {label}
        </div>
      ) : field.type === "RADIO" ||
        field.type === "MULTI_SELECT" ||
        field.type === "RATING" ? (
        control
      ) : (
        <>
          {label}
          {control}
        </>
      )}
      {field.description ? (
        <p id={descriptionId} className="fr-description">
          {field.description}
        </p>
      ) : null}
      {error && (
        <p id={errorId} className="fr-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormRenderer({
  schema,
  mode,
  onSubmit,
  successActions,
}: FormRendererProps) {
  const [entered, setEntered] = useState<FieldValues>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [succeeded, setSucceeded] = useState(false);
  const [sending, setSending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const sendingRef = useRef(false);

  // Unsupported or malformed fields are skipped rather than crashing.
  const fields = useMemo(
    () =>
      Array.isArray(schema?.fields)
        ? (schema.fields as unknown[]).filter(isSupportedField)
        : [],
    [schema],
  );

  const interactive = mode !== "builder";

  // Entered values win; everything else falls back to the schema default.
  const values = useMemo(() => {
    const result: FieldValues = {};
    for (const field of fields) {
      result[field.id] = entered[field.id] ?? defaultValueFor(field);
    }
    return result;
  }, [fields, entered]);

  // Derived, never stored: always matches the current values and schema.
  const errors = useMemo<FieldErrors>(
    () => validateForm(fields, values),
    [fields, values],
  );

  const handleChange = (fieldId: string, value: FieldValue) => {
    setEntered((current) => ({ ...current, [fieldId]: value }));
    setSucceeded(false);
    setServerErrors((current) => {
      if (!(fieldId in current)) return current;
      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  };

  const handleBlur = (fieldId: string) => {
    setTouched((current) =>
      current[fieldId] ? current : { ...current, [fieldId]: true },
    );
  };

  const send = async (handler: FormSubmitHandler) => {
    // One request at a time, even on a rapid double click.
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setFormError(null);
    setServerErrors({});

    try {
      const result = await handler({ ...values });
      if (result.ok) {
        setSummary(result.summary);
        setSucceeded(true);
      } else {
        setFormError(result.message);
        setServerErrors(result.fieldErrors ?? {});
      }
    } catch {
      setFormError("Unable to submit the form. Please try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!interactive) return;

    setSubmitted(true);

    if (Object.keys(errors).length === 0) {
      if (onSubmit) {
        void send(onSubmit);
        return;
      }
      setSucceeded(true);
      return;
    }

    const firstInvalid = fields.find((field) => errors[field.id]);
    if (firstInvalid) {
      event.currentTarget
        .querySelector<HTMLElement>(`[id="fr-${firstInvalid.id}"]`)
        ?.focus();
    }
  };

  const reset = () => {
    setEntered({});
    setTouched({});
    setSubmitted(false);
    setSucceeded(false);
    setSummary(null);
    setFormError(null);
    setServerErrors({});
  };

  if (succeeded && onSubmit) {
    return (
      <div className="fr-success" role="status" data-mode={mode}>
        <h2 className="fr-success-title">Response submitted</h2>
        <p className="fr-success-text">{summary}</p>
        <div className="fr-success-actions">
          <button type="button" className="fb-button" onClick={reset}>
            Submit another response
          </button>
          {successActions}
        </div>
      </div>
    );
  }

  if (succeeded) {
    return (
      <div className="fr-success" role="status" data-mode={mode}>
        <h2 className="fr-success-title">Everything looks good</h2>
        <p className="fr-success-text">
          Your answers passed validation. This was only a test, so nothing was
          saved or sent.
        </p>
        <button type="button" className="fb-button" onClick={reset}>
          Start over
        </button>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <p className="fr-empty" data-mode={mode}>
        This form has no fields yet.
      </p>
    );
  }

  const shownError = (field: FormFieldDefinition): string | undefined =>
    serverErrors[field.id] ??
    (submitted || touched[field.id] ? errors[field.id] : undefined);

  const invalidCount = fields.filter((field) => shownError(field)).length;

  return (
    <form
      className="fr-form"
      data-mode={mode}
      noValidate
      onSubmit={handleSubmit}
      aria-label="Form"
    >
      {submitted && invalidCount > 0 && (
        <p className="fr-summary" role="alert">
          Please fix {invalidCount} {invalidCount === 1 ? "field" : "fields"}{" "}
          below.
        </p>
      )}

      {formError && (
        <p className="fr-summary" role="alert">
          {formError}
        </p>
      )}

      {fields.map((field) => (
        <FieldView
          key={field.id}
          field={field}
          value={values[field.id]}
          error={shownError(field)}
          readOnly={!interactive || sending}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      ))}

      {interactive && (
        <div className="fr-actions">
          <button
            type="submit"
            className="fb-button fb-button-primary"
            disabled={sending}
            aria-busy={sending}
          >
            {sending ? "Submitting…" : "Submit"}
          </button>
        </div>
      )}
    </form>
  );
}
