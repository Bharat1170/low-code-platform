import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ApiError,
  fetchPublishedForm,
  type PublishedFormView,
} from "../../form-builder/api/forms.api.ts";
import { FormRenderer } from "./FormRenderer.tsx";
import "../../form-builder/styles/form-builder.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; form: PublishedFormView };

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.code === "FORM_NOT_PUBLISHED") {
      return "This form hasn't been published yet.";
    }
    if (error.status === 403) return "You don't have permission to view this form.";
    if (error.status === 404 || error.status === 400) {
      return "This form was not found.";
    }
  }

  return "Unable to load the form. Please try again.";
};

/*
 * "Test User": the immutable published version, read-only. The URL holds
 * only the form id; the server resolves organization and version from the
 * signed-in session. Nothing is saved, published or submitted here.
 */
export function PublishedFormPage() {
  const { formId } = useParams<{ formId: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!formId) return;
    let cancelled = false;

    fetchPublishedForm(formId)
      .then((form) => {
        if (!cancelled) setState({ kind: "ready", form });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [formId]);

  if (state.kind !== "ready") {
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

  const { form } = state;

  return (
    <div className="fr-page">
      <div className="fr-banner" role="note">
        Test preview of the published form (version {form.version}). Submissions
        are not enabled yet.
      </div>
      <main className="fr-card">
        <h1 className="fr-title">{form.name}</h1>
        <FormRenderer schema={form.schema} mode="published" />
      </main>
    </div>
  );
}
