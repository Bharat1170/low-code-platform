import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ApiError,
  fetchPublishedForm,
  submitForm,
  type PublishedFormView,
} from "../../form-builder/api/forms.api.ts";
import type {
  FormSubmitHandler,
  SubmitResult,
} from "../types/form-renderer.types.ts";
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

/* Safe, user-facing text for a failed submit; never the server's message. */
const submitFailure = (error: unknown): SubmitResult => {
  if (error instanceof ApiError) {
    if (error.code === "VALIDATION_ERROR") {
      return {
        ok: false,
        message: "Please fix the highlighted fields and try again.",
        fieldErrors: error.fields,
      };
    }
    if (error.code === "FORM_NOT_PUBLISHED") {
      return { ok: false, message: "This form is no longer published." };
    }
    if (error.status === 401) {
      return { ok: false, message: "Your session has expired. Please sign in again." };
    }
    if (error.status === 403) {
      return { ok: false, message: "You don't have permission to submit this form." };
    }
    if (error.status === 413) {
      return { ok: false, message: "Your answers are too large to submit." };
    }
    if (error.status === 429) {
      return { ok: false, message: "Too many requests. Please wait a moment and try again." };
    }
    if (error.status === 0) {
      return {
        ok: false,
        message: "Unable to reach the server. Check your connection and try again.",
      };
    }
  }

  return { ok: false, message: "Unable to submit the form. Please try again." };
};

/*
 * "Test User": the published version of the form, filled in the way a
 * respondent sees it. The URL holds only the form id; the server resolves
 * organization and version from the signed-in session. Submitting sends a
 * real submission ({ data } only) to the server, which validates it again
 * against the published version; it then appears under Submissions.
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

  const handleSubmit: FormSubmitHandler = async (values) => {
    try {
      const receipt = await submitForm(formId ?? "", values);
      return {
        ok: true,
        summary: `Your response was saved as submission ${receipt.id.slice(-8)} (form version ${receipt.version}). It now appears under Submissions.`,
      };
    } catch (error: unknown) {
      return submitFailure(error);
    }
  };

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
        Testing the published form (version {form.version}). Submitting saves a
        real submission that you can review under{" "}
        <Link to={`/forms/${encodeURIComponent(form.formId)}/submissions`}>
          Submissions
        </Link>
        .
      </div>
      <main className="fr-card">
        <h1 className="fr-title">{form.name}</h1>
        <FormRenderer
          schema={form.schema}
          mode="published"
          onSubmit={handleSubmit}
          successActions={
            <Link
              className="fb-button"
              to={`/forms/${encodeURIComponent(form.formId)}/submissions`}
            >
              View submissions
            </Link>
          }
        />
      </main>
    </div>
  );
}
