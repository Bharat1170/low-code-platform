import type { FormSchema } from "../types/form-builder.types.ts";
import { FormField } from "./FormField.tsx";

interface FormCanvasProps {
  schema: FormSchema;
  selectedFieldId: string | null;
  onSelectField: (fieldId: string) => void;
  onRemoveField: (fieldId: string) => void;
  onAddFirstField: () => void;
}

export function FormCanvas({
  schema,
  selectedFieldId,
  onSelectField,
  onRemoveField,
  onAddFirstField,
}: FormCanvasProps) {
  return (
    <main className="fb-canvas" aria-label="Form canvas">
      <div className="fb-canvas-inner">
        {schema.fields.length === 0 ? (
          <div className="fb-empty">
            <div className="fb-empty-mark" aria-hidden="true">
              <svg
                viewBox="0 0 48 48"
                width="40"
                height="40"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="8" y="8" width="32" height="10" rx="3" />
                <rect x="8" y="24" width="32" height="10" rx="3" opacity="0.5" />
                <path d="M24 38v6M21 41h6" />
              </svg>
            </div>
            <h2 className="fb-empty-title">Build your form</h2>
            <p className="fb-empty-text">
              Add fields from the panel to start creating your form.
            </p>
            <button
              type="button"
              className="fb-button fb-button-primary"
              onClick={onAddFirstField}
            >
              + Add your first field
            </button>
          </div>
        ) : (
          <>
            <div className="fb-canvas-heading">
              <h2 className="fb-canvas-title">Untitled form</h2>
              <p className="fb-canvas-count">
                {schema.fields.length}{" "}
                {schema.fields.length === 1 ? "field" : "fields"}
              </p>
            </div>
            <ul className="fb-field-list">
              {schema.fields.map((field, index) => (
                <FormField
                  key={field.id}
                  field={field}
                  displayNumber={index + 1}
                  selected={field.id === selectedFieldId}
                  onSelect={onSelectField}
                  onRemove={onRemoveField}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
