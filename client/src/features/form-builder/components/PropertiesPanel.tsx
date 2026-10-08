import { useId, useState } from "react";
import { getFieldRegistryEntry } from "../registry/field-registry.ts";
import type {
  DropdownFieldDefinition,
  FormFieldDefinition,
  MultiSelectFieldDefinition,
  RadioFieldDefinition,
  ValidationConfig,
} from "../types/form-builder.types.ts";
import {
  MAX_RATING_SCALE,
  MIN_RATING_SCALE,
  NUMBER_TEXT,
} from "../utils/form-schema.validate.ts";
import { isValidDateOnly } from "../utils/date-only.ts";
import type { FieldChanges } from "../utils/form-schema.utils.ts";

export type UpdateFieldHandler = (
  fieldId: string,
  changes: FieldChanges,
) => void;

interface PropertiesPanelProps {
  field: FormFieldDefinition | null;
  onUpdateField: UpdateFieldHandler;
}

/* ---------- Small building blocks ---------- */

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="fb-props-section">
      <h3 className="fb-section-label">{title}</h3>
      <div className="fb-props-stack">{children}</div>
    </section>
  );
}

function TextProperty({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const id = useId();

  return (
    <div className="fb-prop">
      <label className="fb-prop-label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className="fb-control fb-textarea"
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="fb-control"
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

/*
 * Date-only input ("YYYY-MM-DD"). A cleared input clears the value; a
 * value that breaks the allowed range is shown as an inline error and is
 * not committed, so the schema never holds an inconsistent date range.
 */
function DateProperty({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: string | undefined;
  /* Inclusive bounds this value must respect. */
  min?: string;
  max?: string;
  onCommit: (value: string | undefined) => void;
}) {
  const id = useId();
  const errorId = useId();
  const [error, setError] = useState<string | null>(null);

  const handleChange = (next: string) => {
    if (next === "") {
      setError(null);
      onCommit(undefined);
      return;
    }
    if (!isValidDateOnly(next)) {
      setError("Enter a valid date.");
      return;
    }
    if (min !== undefined && next < min) {
      setError(`Must be on or after ${min}.`);
      return;
    }
    if (max !== undefined && next > max) {
      setError(`Must be on or before ${max}.`);
      return;
    }
    setError(null);
    onCommit(next);
  };

  return (
    <div className="fb-prop">
      <label className="fb-prop-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="fb-control"
        type="date"
        value={value ?? ""}
        min={min}
        max={max}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => handleChange(event.target.value)}
      />
      {error && (
        <p id={errorId} className="fb-prop-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ToggleProperty({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();

  return (
    <div className="fb-prop fb-prop-toggle">
      <label className="fb-prop-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="fb-switch"
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/*
 * Whole-number input. Keeps a local draft so the user can clear or retype
 * the value; only valid values reach the schema. An empty draft clears the
 * limit. Invalid drafts show an inline error and leave the schema alone.
 */
function LengthProperty({
  label,
  value,
  otherBound,
  kind,
  onCommit,
  noun = "length",
}: {
  label: string;
  value: number | undefined;
  otherBound: number | undefined;
  kind: "min" | "max";
  onCommit: (value: number | undefined) => void;
  /* What is bounded, for messages ("length", "selections"). */
  noun?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);

  const handleChange = (raw: string) => {
    setDraft(raw);

    if (raw.trim() === "") {
      setError(null);
      onCommit(undefined);
      return;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 0) {
      setError("Enter a whole number of 0 or more.");
      return;
    }

    if (otherBound !== undefined) {
      if (kind === "min" && parsed > otherBound) {
        setError(`Minimum ${noun} cannot exceed maximum ${noun}.`);
        return;
      }
      if (kind === "max" && parsed < otherBound) {
        setError(`Maximum ${noun} cannot be less than minimum ${noun}.`);
        return;
      }
    }

    setError(null);
    onCommit(parsed);
  };

  return (
    <div className="fb-prop">
      <label className="fb-prop-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="fb-control"
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        value={draft}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => handleChange(event.target.value)}
      />
      {error && (
        <p id={errorId} className="fb-prop-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/*
 * Decimal bound for a NUMBER field. Same draft/commit behaviour as
 * LengthProperty: an empty draft clears the bound, an invalid one is shown
 * and never reaches the schema.
 */
function NumberBoundProperty({
  label,
  value,
  otherBound,
  kind,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  otherBound: number | undefined;
  kind: "min" | "max";
  onCommit: (value: number | undefined) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);

  const handleChange = (raw: string) => {
    setDraft(raw);
    const text = raw.trim();

    if (text === "") {
      setError(null);
      onCommit(undefined);
      return;
    }
    if (!NUMBER_TEXT.test(text) || text.length > 32) {
      setError("Enter a number, e.g. 10 or 2.5.");
      return;
    }

    const parsed = Number(text);
    if (otherBound !== undefined) {
      if (kind === "min" && parsed > otherBound) {
        setError("Minimum cannot exceed maximum.");
        return;
      }
      if (kind === "max" && parsed < otherBound) {
        setError("Maximum cannot be less than minimum.");
        return;
      }
    }

    setError(null);
    onCommit(parsed);
  };

  return (
    <div className="fb-prop">
      <label className="fb-prop-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="fb-control"
        type="text"
        inputMode="decimal"
        value={draft}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => handleChange(event.target.value)}
      />
      {error && (
        <p id={errorId} className="fb-prop-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* A small select of whole numbers (rating scale and default). */
function SelectNumberProperty({
  label,
  value,
  from,
  to,
  zeroLabel,
  onChange,
}: {
  label: string;
  value: number;
  from: number;
  to: number;
  /* Shown for 0 instead of the number (e.g. "No default"). */
  zeroLabel?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();

  return (
    <div className="fb-prop">
      <label className="fb-prop-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="fb-control fb-control-select"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {Array.from({ length: to - from + 1 }, (_, index) => from + index).map(
          (n) => (
            <option key={n} value={n}>
              {n === 0 && zeroLabel ? zeroLabel : n}
            </option>
          ),
        )}
      </select>
    </div>
  );
}

/* ---------- Dropdown options ---------- */

function OptionsEditor({
  field,
  onUpdateField,
}: {
  field: DropdownFieldDefinition | RadioFieldDefinition | MultiSelectFieldDefinition;
  onUpdateField: UpdateFieldHandler;
}) {
  const { options } = field.config;

  const commit = (nextOptions: typeof options) => {
    // Never leave a default pointing at an option that no longer exists.
    const exists = (value: string) => nextOptions.some((o) => o.value === value);
    const defaultValue =
      field.type === "MULTI_SELECT"
        ? field.config.defaultValue.filter(exists)
        : exists(field.config.defaultValue)
          ? field.config.defaultValue
          : "";
    onUpdateField(field.id, {
      config: { options: nextOptions, defaultValue },
    });
  };

  const editOption = (index: number, key: "label" | "value", text: string) => {
    commit(
      options.map((option, i) =>
        i === index ? { label: option.label, value: option.value, [key]: text } : option,
      ),
    );
  };

  const addOption = () => {
    const used = new Set(options.map((o) => o.value));
    let n = options.length + 1;
    while (used.has(`option-${n}`)) {
      n += 1;
    }
    commit([...options, { label: `Option ${n}`, value: `option-${n}` }]);
  };

  const values = options.map((o) => o.value);
  const hasBlank = options.some((o) => !o.label.trim() || !o.value.trim());
  const hasDuplicate = new Set(values).size !== values.length;

  return (
    <div className="fb-options">
      {options.length > 0 && (
        <div className="fb-options-head" aria-hidden="true">
          <span>Label</span>
          <span>Value</span>
          <span />
        </div>
      )}

      <ul className="fb-options-list">
        {options.map((option, index) => (
          <li className="fb-option-row" key={index}>
            <input
              className="fb-control fb-control-sm"
              type="text"
              aria-label={`Option ${index + 1} label`}
              value={option.label}
              onChange={(e) => editOption(index, "label", e.target.value)}
            />
            <input
              className="fb-control fb-control-sm"
              type="text"
              aria-label={`Option ${index + 1} value`}
              value={option.value}
              onChange={(e) => editOption(index, "value", e.target.value)}
            />
            <button
              type="button"
              className="fb-icon-button"
              aria-label={`Remove ${option.label || `option ${index + 1}`} option`}
              onClick={() => commit(options.filter((_, i) => i !== index))}
            >
              <svg
                viewBox="0 0 20 20"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="m6 6 8 8M14 6l-8 8" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {(hasBlank || hasDuplicate) && (
        <p className="fb-prop-error" role="alert">
          {hasBlank
            ? "Every option needs a label and a value."
            : "Option values must be unique."}
        </p>
      )}

      <button type="button" className="fb-button fb-button-block" onClick={addOption}>
        + Add option
      </button>
    </div>
  );
}

/* ---------- Panel ---------- */

export function PropertiesPanel({ field, onUpdateField }: PropertiesPanelProps) {
  if (!field) {
    return (
      <aside className="fb-props" aria-label="Field properties">
        <h2 className="fb-section-label fb-props-heading">Field properties</h2>
        <div className="fb-props-empty">
          <div className="fb-props-empty-mark" aria-hidden="true">
            <svg
              viewBox="0 0 20 20"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 5h7M15 5h1M4 10h2M10 10h6M4 15h9M17 15h-1" />
              <circle cx="13" cy="5" r="1.6" />
              <circle cx="8" cy="10" r="1.6" />
              <circle cx="15" cy="15" r="1.6" />
            </svg>
          </div>
          <h3 className="fb-props-empty-title">Select a field</h3>
          <p className="fb-props-empty-text">
            Choose a field on the canvas to configure its properties.
          </p>
        </div>
      </aside>
    );
  }

  const entry = getFieldRegistryEntry(field.type);
  const update = (changes: FieldChanges) => onUpdateField(field.id, changes);

  const updateValidation = (
    key: "minLength" | "maxLength" | "minDate" | "maxDate" | "min" | "max" | "integer",
    value: number | string | boolean | undefined,
  ) => {
    // Spread keeps every other rule; an undefined limit removes only its own key.
    const next: ValidationConfig = { ...field.validation };
    if (value === undefined) {
      delete next[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
    update({ validation: next });
  };

  return (
    // Keyed by field id so local drafts never leak between fields.
    <aside className="fb-props" aria-label="Field properties" key={field.id}>
      <h2 className="fb-section-label fb-props-heading">Field properties</h2>
      <div className="fb-props-intro">
        <p className="fb-props-type">{entry.label} field</p>
        <p className="fb-props-sub">Configure the selected field</p>
      </div>

      <Section title="General">
        <TextProperty
          label="Label"
          value={field.label}
          onChange={(label) => update({ label })}
        />
        <TextProperty
          label="Description"
          value={field.description}
          multiline
          onChange={(description) => update({ description })}
        />
        <ToggleProperty
          label="Required"
          checked={field.required}
          onChange={(required) => update({ required })}
        />
      </Section>

      {(field.type === "TEXT" ||
        field.type === "EMAIL" ||
        field.type === "TEXTAREA" ||
        field.type === "PHONE" ||
        field.type === "URL") && (
        <>
          <Section title="Input">
            <TextProperty
              label="Placeholder"
              value={field.config.placeholder}
              onChange={(placeholder) => update({ config: { placeholder } })}
            />
            <TextProperty
              label="Default value"
              value={field.config.defaultValue}
              onChange={(defaultValue) => update({ config: { defaultValue } })}
            />
          </Section>
          <Section title="Validation">
            <LengthProperty
              label="Minimum length"
              kind="min"
              value={field.validation.minLength}
              otherBound={field.validation.maxLength}
              onCommit={(v) => updateValidation("minLength", v)}
            />
            <LengthProperty
              label="Maximum length"
              kind="max"
              value={field.validation.maxLength}
              otherBound={field.validation.minLength}
              onCommit={(v) => updateValidation("maxLength", v)}
            />
          </Section>
        </>
      )}

      {field.type === "NUMBER" && (
        <>
          <Section title="Input">
            <TextProperty
              label="Placeholder"
              value={field.config.placeholder}
              onChange={(placeholder) => update({ config: { placeholder } })}
            />
          </Section>
          <Section title="Validation">
            <NumberBoundProperty
              label="Minimum value"
              kind="min"
              value={field.validation.min}
              otherBound={field.validation.max}
              onCommit={(v) => updateValidation("min", v)}
            />
            <NumberBoundProperty
              label="Maximum value"
              kind="max"
              value={field.validation.max}
              otherBound={field.validation.min}
              onCommit={(v) => updateValidation("max", v)}
            />
            <ToggleProperty
              label="Whole numbers only"
              checked={field.validation.integer === true}
              onChange={(on) => updateValidation("integer", on ? true : undefined)}
            />
          </Section>
        </>
      )}

      {(field.type === "DROPDOWN" ||
        field.type === "RADIO" ||
        field.type === "MULTI_SELECT") && (
        <Section title="Options">
          <OptionsEditor field={field} onUpdateField={onUpdateField} />
        </Section>
      )}

      {field.type === "MULTI_SELECT" && (
        <Section title="Validation">
          <LengthProperty
            label="Minimum selections"
            kind="min"
            noun="selections"
            value={field.validation.min}
            otherBound={field.validation.max}
            onCommit={(v) => updateValidation("min", v)}
          />
          <LengthProperty
            label="Maximum selections"
            kind="max"
            noun="selections"
            value={field.validation.max}
            otherBound={field.validation.min}
            onCommit={(v) => updateValidation("max", v)}
          />
        </Section>
      )}

      {field.type === "RATING" && (
        <Section title="Scale">
          <SelectNumberProperty
            label="Number of stars"
            value={field.config.max}
            from={MIN_RATING_SCALE}
            to={MAX_RATING_SCALE}
            onChange={(max) =>
              update({
                config: {
                  max,
                  defaultValue: Math.min(field.config.defaultValue, max),
                },
              })
            }
          />
          <SelectNumberProperty
            label="Default rating"
            value={field.config.defaultValue}
            from={0}
            to={field.config.max}
            zeroLabel="No default"
            onChange={(defaultValue) => update({ config: { defaultValue } })}
          />
        </Section>
      )}

      {field.type === "DATE" && (
        <>
          <Section title="Input">
            <DateProperty
              label="Default value"
              value={field.config.defaultValue}
              min={field.validation.minDate}
              max={field.validation.maxDate}
              onCommit={(defaultValue) =>
                update({ config: { defaultValue: defaultValue ?? "" } })
              }
            />
          </Section>
          <Section title="Validation">
            <DateProperty
              label="Minimum date"
              value={field.validation.minDate}
              max={field.validation.maxDate}
              onCommit={(v) => updateValidation("minDate", v)}
            />
            <DateProperty
              label="Maximum date"
              value={field.validation.maxDate}
              min={field.validation.minDate}
              onCommit={(v) => updateValidation("maxDate", v)}
            />
          </Section>
        </>
      )}

      {field.type === "CHECKBOX" && (
        <Section title="Input">
          <ToggleProperty
            label="Default checked"
            checked={field.config.defaultValue}
            onChange={(defaultValue) => update({ config: { defaultValue } })}
          />
        </Section>
      )}
    </aside>
  );
}
