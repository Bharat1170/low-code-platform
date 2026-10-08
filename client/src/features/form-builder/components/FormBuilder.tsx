import { useRef, useState, type ReactNode } from "react";
import { publishForm, saveFormDraft, type PublishResult } from "../api/forms.api.ts";
import { useDraftAutosave } from "../hooks/useDraftAutosave.ts";
import {
  addField,
  areSchemasEqual,
  createEmptyFormSchema,
  createFieldDefinition,
  findFieldById,
  removeField,
  updateField,
  type FieldChanges,
} from "../utils/form-schema.utils.ts";
import type { FieldType, FormSchema } from "../types/form-builder.types.ts";
import { FieldPalette } from "./FieldPalette.tsx";
import { FormCanvas } from "./FormCanvas.tsx";
import { PropertiesPanel } from "./PropertiesPanel.tsx";
import type { FormStatusValue } from "../utils/form-status.ts";
import { FormStatusBadge } from "./FormStatusBadge.tsx";
import { PublishControl } from "./PublishControl.tsx";
import { TestUserButton, type PreviewWindow } from "./TestUserButton.tsx";
import { SaveStatus } from "./SaveStatus.tsx";
import "../styles/form-builder.css";

interface FormBuilderProps {
  initialSchema?: FormSchema;
  /* The persisted form being edited. Without it nothing is saved. */
  formId?: string;
  /* Persistence function; defaults to the real Form API. */
  saveDraft?: (formId: string, schema: FormSchema) => Promise<void>;
  /* Publishes the saved draft; defaults to the real Form API. */
  publish?: (formId: string) => Promise<PublishResult>;
  /* The form already has a published version when it is opened. */
  initiallyPublished?: boolean;
  /* The form's status from the server when it was opened. */
  initialStatus?: FormStatusValue;
  /*
   * For a builder opened without a form: creates the form on the server
   * and resolves its id. It runs the first time something is saved, so
   * Save Draft, autosave and Publish work without a pre-existing form.
   */
  createForm?: () => Promise<string>;
  /* Called once a form was created by createForm (e.g. to update the URL). */
  onFormCreated?: (formId: string) => void;
  /* Opens the Test User preview tab (tests); defaults to a new browser tab. */
  openPreviewWindow?: () => PreviewWindow | null;
  /* Extra controls (e.g. the account menu) shown at the end of the header. */
  headerExtras?: ReactNode;
}

export function FormBuilder({
  initialSchema,
  formId,
  saveDraft = saveFormDraft,
  publish = publishForm,
  initiallyPublished = false,
  initialStatus,
  createForm,
  onFormCreated,
  openPreviewWindow,
  headerExtras,
}: FormBuilderProps) {
  const [schema, setSchema] = useState<FormSchema>(
    () => initialSchema ?? createEmptyFormSchema(),
  );
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const [formStatus, setFormStatus] = useState<FormStatusValue>(
    initialStatus ?? (initiallyPublished ? "PUBLISHED" : "DRAFT"),
  );
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  /* The schema that was just published, to avoid publishing it again. */
  const [publishedSchema, setPublishedSchema] = useState<FormSchema | null>(
    null,
  );

  // A builder is saveable when it has a form, or can create one.
  const persistent = formId !== undefined || createForm !== undefined;
  const [createdId, setCreatedId] = useState<string | undefined>();
  const targetIdRef = useRef<string | undefined>(formId);
  const effectiveFormId = formId ?? createdId;

  const { status, saveNow, ensureSaved } = useDraftAutosave({
    schema,
    enabled: persistent,
    save: async (snapshot) => {
      let id = targetIdRef.current;

      if (id === undefined) {
        if (!createForm) throw new Error("No form to save to");
        // Saves are serialized by the hook, so this runs at most once.
        id = await createForm();
        targetIdRef.current = id;
        setCreatedId(id);
        onFormCreated?.(id);
      }

      await saveDraft(id, snapshot);
    },
  });

  /* Latest edits saved (form created if needed); the form id, or null. */
  const ensureSavedForPublish = async (): Promise<string | null> => {
    const saved = await ensureSaved(targetIdRef.current === undefined);
    return saved ? (targetIdRef.current ?? null) : null;
  };

  const handlePublished = (result: PublishResult) => {
    setFormStatus("PUBLISHED");
    setPublishedVersion(result.version);
    setPublishedSchema(schema);
  };

  const handleAddField = (type: FieldType) => {
    const field = createFieldDefinition(type);
    setSchema((current) => addField(current, field));
    setSelectedFieldId(field.id);
  };

  const handleRemoveField = (fieldId: string) => {
    setSchema((current) => removeField(current, fieldId));
    setSelectedFieldId((current) => (current === fieldId ? null : current));
  };

  const handleUpdateField = (fieldId: string, changes: FieldChanges) => {
    setSchema((current) => updateField(current, fieldId, changes));
  };

  const selectedField =
    selectedFieldId === null ? null : (findFieldById(schema, selectedFieldId) ?? null);

  return (
    <div className="fb-root">
      <header className="fb-header">
        <div className="fb-header-left">
          <span className="fb-logo" aria-hidden="true" />
          <span className="fb-breadcrumb">Forms</span>
          <span className="fb-breadcrumb-sep" aria-hidden="true">
            /
          </span>
          <h1 className="fb-title">Form Builder</h1>
        </div>
        <div className="fb-header-right">
          {formStatus !== "DRAFT" && (
            <FormStatusBadge status={formStatus} version={publishedVersion} />
          )}
          {persistent && <SaveStatus status={status} />}
          <button
            type="button"
            className="fb-button"
            onClick={saveNow}
            disabled={!persistent || status === "saving" || status === "saved"}
            aria-busy={status === "saving"}
            title={persistent && status === "saved" ? "No changes to save" : undefined}
          >
            {status === "saving" ? "Saving..." : "Save Draft"}
          </button>
          <PublishControl
            formId={effectiveFormId}
            draftSaved={status === "saved"}
            ensureSaved={createForm || formId !== undefined ? ensureSavedForPublish : undefined}
            saving={status === "saving"}
            initiallyPublished={initiallyPublished}
            publish={publish}
            onPublished={handlePublished}
            showBadge={false}
            archived={formStatus === "ARCHIVED"}
            unchangedSincePublish={
              publishedSchema !== null && areSchemasEqual(schema, publishedSchema)
            }
          />
          <TestUserButton
            prepare={
              createForm || formId !== undefined ? ensureSavedForPublish : undefined
            }
            openWindow={openPreviewWindow}
          />
          {headerExtras}
        </div>
      </header>

      <div className="fb-body">
        <FieldPalette onAddField={handleAddField} />
        <FormCanvas
          schema={schema}
          selectedFieldId={selectedFieldId}
          onSelectField={setSelectedFieldId}
          onRemoveField={handleRemoveField}
          onAddFirstField={() => handleAddField("TEXT")}
        />
        <PropertiesPanel
          field={selectedField}
          onUpdateField={handleUpdateField}
        />
      </div>
    </div>
  );
}
