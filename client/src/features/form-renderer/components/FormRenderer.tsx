import { useMemo, useState, type FormEvent } from "react";
import type {
  FormFieldDefinition,
  FormSchema,
} from "../../form-builder/types/form-builder.types.ts";
import type {
  FieldErrors,
  FieldValue,
  FieldValues,
  FormRendererMode,
} from "../types/form-renderer.types.ts";
import {
  defaultValueFor,
  dropdownOptions,
  fieldLabel,
  isRequired,
  isSupportedField,
  validateForm,
} from "../utils/form-validation.ts";
import "../styles/form-renderer.css";

interface FormRendererProps {
  schema: FormSchema;
  mode: FormRendererMode;
}

/*
 * The one rendering engine for a FormSchema. It only reads the schema and
 * keeps what the person types (values, touched, submitted) in its own
 * state, so it can never change the schema, autosave, publish or submit
 * anything. Labels, descriptions and options are rendered as text.
 *
 * Submitting validates locally and shows a local confirmation only;
 * nothing is persisted yet.
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

  const label = (
    <label className="fr-label" htmlFor={controlId}>
      {fieldLabel(field)}
      {required && (
        <>
          <span className="fr-required" aria-hidden="true">
            *
          </span>
          <span className="fr-sr-only"> (required)</span>
        </>
      )}
    </label>
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

export function FormRenderer({ schema, mode }: FormRendererProps) {
  const [entered, setEntered] = useState<FieldValues>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

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
  };

  const handleBlur = (fieldId: string) => {
    setTouched((current) =>
      current[fieldId] ? current : { ...current, [fieldId]: true },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!interactive) return;

    setSubmitted(true);

    if (Object.keys(errors).length === 0) {
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
  };

  if (succeeded) {
    return (
      <div className="fr-success" role="status" data-mode={mode}>
        <h2 className="fr-success-title">Everything looks good</h2>
        <p className="fr-success-text">
          Your answers passed validation. Submissions are not enabled yet, so
          nothing was saved or sent.
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
    submitted || touched[field.id] ? errors[field.id] : undefined;

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

      {fields.map((field) => (
        <FieldView
          key={field.id}
          field={field}
          value={values[field.id]}
          error={shownError(field)}
          readOnly={!interactive}
          onChange={handleChange}
          onBlur={handleBlur}
        />
      ))}

      {interactive && (
        <div className="fr-actions">
          <button type="submit" className="fb-button fb-button-primary">
            Submit
          </button>
        </div>
      )}
    </form>
  );
}
