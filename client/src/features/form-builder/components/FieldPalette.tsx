import { listFieldRegistryEntries } from "../registry/field-registry.ts";
import type { FieldType } from "../types/form-builder.types.ts";
import { FieldIcon } from "./FieldIcon.tsx";

/* Presentational hints only; names, icons and order come from the registry. */
const TYPE_HINTS: Record<FieldType, string> = {
  TEXT: "Single-line text",
  EMAIL: "Email address",
  DROPDOWN: "Choose from a list",
  CHECKBOX: "Yes or no option",
  DATE: "Pick a date",
  TEXTAREA: "Multi-line answer",
  NUMBER: "Numeric value",
  PHONE: "Phone number",
  URL: "Web address",
  RADIO: "Pick one option",
  MULTI_SELECT: "Pick several options",
  RATING: "1 to 5 stars",
};

interface FieldPaletteProps {
  onAddField: (type: FieldType) => void;
}

export function FieldPalette({ onAddField }: FieldPaletteProps) {
  const entries = listFieldRegistryEntries();

  return (
    <aside className="fb-palette" aria-label="Field palette">
      <h2 className="fb-section-label">Add fields</h2>
      <ul className="fb-palette-list">
        {entries.map((entry) => (
          <li key={entry.type}>
            <button
              type="button"
              className="fb-palette-item"
              onClick={() => onAddField(entry.type)}
              aria-label={`Add ${entry.label} field`}
            >
              <span className="fb-palette-icon">
                <FieldIcon icon={entry.icon} />
              </span>
              <span className="fb-palette-text">
                <span className="fb-palette-name">{entry.label}</span>
                <span className="fb-palette-hint">
                  {TYPE_HINTS[entry.type]}
                </span>
              </span>
              <span className="fb-palette-add" aria-hidden="true">
                +
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
