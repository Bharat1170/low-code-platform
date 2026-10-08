import { getFieldRegistryEntry } from "../registry/field-registry.ts";
import type { FormFieldDefinition } from "../types/form-builder.types.ts";
import { FieldIcon } from "./FieldIcon.tsx";

interface FormFieldProps {
  field: FormFieldDefinition;
  /*
   * Position in the canvas (1-based). Presentation only: derived from the
   * current array order, never stored in the schema, never sent to the
   * backend and never used as an id or React key.
   */
  displayNumber: number;
  selected: boolean;
  onSelect: (fieldId: string) => void;
  onRemove: (fieldId: string) => void;
}

/* Static preview of the control. Never interactive, never submitted. */
function FieldPreview({ field }: { field: FormFieldDefinition }) {
  const controlId = `${field.id}-preview`;

  switch (field.type) {
    case "TEXT":
    case "EMAIL":
      return (
        <div className="fb-preview">
          <label className="fb-preview-label" htmlFor={controlId}>
            {field.label}
          </label>
          <input
            id={controlId}
            className="fb-control"
            type={field.type === "EMAIL" ? "email" : "text"}
            placeholder={field.config.placeholder}
            value={field.config.defaultValue}
            readOnly
            tabIndex={-1}
          />
        </div>
      );

    case "DROPDOWN":
      return (
        <div className="fb-preview">
          <label className="fb-preview-label" htmlFor={controlId}>
            {field.label}
          </label>
          <select
            id={controlId}
            className="fb-control fb-control-select"
            value={field.config.defaultValue}
            disabled
            tabIndex={-1}
          >
            <option value="">{field.config.placeholder}</option>
            {field.config.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );

    case "DATE":
      return (
        <div className="fb-preview">
          <label className="fb-preview-label" htmlFor={controlId}>
            {field.label}
          </label>
          <input
            id={controlId}
            className="fb-control"
            type="date"
            value={field.config.defaultValue}
            readOnly
            tabIndex={-1}
          />
        </div>
      );

    case "TEXTAREA":
      return (
        <div className="fb-preview">
          <label className="fb-preview-label" htmlFor={controlId}>
            {field.label}
          </label>
          <textarea
            id={controlId}
            className="fb-control fr-textarea"
            rows={3}
            placeholder={field.config.placeholder}
            value={field.config.defaultValue}
            readOnly
            tabIndex={-1}
          />
        </div>
      );

    case "NUMBER":
    case "PHONE":
    case "URL":
      return (
        <div className="fb-preview">
          <label className="fb-preview-label" htmlFor={controlId}>
            {field.label}
          </label>
          <input
            id={controlId}
            className="fb-control"
            type={field.type === "PHONE" ? "tel" : field.type === "URL" ? "url" : "text"}
            placeholder={field.config.placeholder}
            value={field.config.defaultValue}
            readOnly
            tabIndex={-1}
          />
        </div>
      );

    case "RADIO":
    case "MULTI_SELECT":
      return (
        <div className="fb-preview">
          <span className="fb-preview-label">{field.label}</span>
          <ul className="fb-preview-choices">
            {field.config.options.map((option) => {
              const on =
                field.type === "RADIO"
                  ? field.config.defaultValue === option.value
                  : field.config.defaultValue.includes(option.value);
              return (
                <li key={option.value}>
                  <input
                    type={field.type === "RADIO" ? "radio" : "checkbox"}
                    checked={on}
                    readOnly
                    disabled
                    tabIndex={-1}
                    aria-label={option.label}
                  />
                  <span>{option.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      );

    case "RATING":
      return (
        <div className="fb-preview">
          <span className="fb-preview-label">{field.label}</span>
          <span
            className="fb-preview-stars"
            aria-label={`Rating out of ${field.config.max}`}
          >
            {Array.from({ length: field.config.max }, (_, index) => (
              <span
                key={index}
                aria-hidden="true"
                data-on={index < field.config.defaultValue ? "true" : undefined}
              >
                ★
              </span>
            ))}
          </span>
        </div>
      );

    case "CHECKBOX":
      return (
        <div className="fb-preview fb-preview-checkbox">
          <input
            id={controlId}
            className="fb-checkbox"
            type="checkbox"
            checked={field.config.defaultValue}
            readOnly
            tabIndex={-1}
          />
          <label className="fb-preview-label" htmlFor={controlId}>
            {field.label}
          </label>
        </div>
      );
  }
}

export function FormField({
  field,
  displayNumber,
  selected,
  onSelect,
  onRemove,
}: FormFieldProps) {
  const entry = getFieldRegistryEntry(field.type);
  // "Text field" would otherwise read "Remove Text field field".
  const accessibleName = field.label.replace(/\s+field$/i, "");

  return (
    <li
      className="fb-field"
      data-selected={selected ? "true" : "false"}
      data-field-type={field.type}
    >
      {/* Real button covering the card: the keyboard-accessible select target. */}
      <button
        type="button"
        className="fb-field-select"
        aria-pressed={selected}
        aria-label={`Select ${accessibleName} field`}
        onClick={() => onSelect(field.id)}
      />

      <div className="fb-field-header">
        <span className="fb-field-type">
          <span className="fb-field-number" data-field-number={displayNumber}>
            {displayNumber}
          </span>
          <FieldIcon icon={entry.icon} />
          {entry.label}
        </span>
        {selected && <span className="fb-field-badge">Selected</span>}
      </div>

      <FieldPreview field={field} />

      <button
        type="button"
        className="fb-field-remove"
        aria-label={`Remove ${accessibleName} field`}
        onClick={() => onRemove(field.id)}
      >
        <svg
          viewBox="0 0 20 20"
          width="16"
          height="16"
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
  );
}
