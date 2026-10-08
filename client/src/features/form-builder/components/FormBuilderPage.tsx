import { useEffect, useState, type ReactNode } from "react";
import { ApiError, fetchForm } from "../api/forms.api.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import { createEmptyFormSchema } from "../utils/form-schema.utils.ts";
import { isFormSchema } from "../utils/form-schema.validate.ts";
import { toFormStatus, type FormStatusValue } from "../utils/form-status.ts";
import { FormBuilder } from "./FormBuilder.tsx";
import "../styles/form-builder.css";

interface FormBuilderPageProps {
  formId: string;
  headerExtras?: ReactNode;
  formsLink?: ReactNode;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      schema: FormSchema;
      name: string;
      description: string;
      published: boolean;
      status: FormStatusValue;
    };

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) return "You need to sign in to edit this form.";
    if (error.status === 403) return "You don't have permission to edit this form.";
    if (error.status === 404) return "This form was not found.";
  }

  return "Unable to load the form. Please try again.";
};

/*
 * Loads the persisted form, then hands its draft schema to the builder.
 * A form with no draft starts from an empty schema; a draft that fails
 * validation is NOT loaded (and so can never be overwritten by an empty
 * one).
 */
export function FormBuilderPage({
  formId,
  headerExtras,
  formsLink,
}: FormBuilderPageProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchForm(formId)
      .then((form) => {
        if (cancelled) return;

        if (form.draftSchema === undefined || form.draftSchema === null) {
          setState({
            kind: "ready",
            schema: createEmptyFormSchema(),
            name: form.name,
            description: form.description,
            published: form.hasPublishedVersion ?? false,
            status: toFormStatus(form.status),
          });
        } else if (isFormSchema(form.draftSchema)) {
          setState({
            kind: "ready",
            schema: form.draftSchema,
            name: form.name,
            description: form.description,
            published: form.hasPublishedVersion ?? false,
            status: toFormStatus(form.status),
          });
        } else {
          setState({
            kind: "error",
            message:
              "This form's saved draft is invalid, so it was not loaded and will not be overwritten.",
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: errorMessage(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [formId]);

  if (state.kind === "ready") {
    return (
      <FormBuilder
        formId={formId}
        initialSchema={state.schema}
        initialName={state.name}
        initialDescription={state.description}
        initiallyPublished={state.published}
        initialStatus={state.status}
        headerExtras={headerExtras}
        formsLink={formsLink}
      />
    );
  }

  return (
    <div className="fb-root fb-page-message" data-state={state.kind}>
      {state.kind === "loading" ? (
        <p role="status">Loading form…</p>
      ) : (
        <p role="alert">{state.message}</p>
      )}
    </div>
  );
}
