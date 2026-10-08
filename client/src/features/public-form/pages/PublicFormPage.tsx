import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FormRenderer } from "../../form-renderer/components/FormRenderer.tsx";
import type {
  FormSubmitHandler,
  SubmitResult,
} from "../../form-renderer/types/form-renderer.types.ts";
import {
  ApiError,
  fetchPublicForm,
  submitPublicForm,
  type PublicForm,
} from "../api/public-forms.api.ts";
import "../../form-builder/styles/form-builder.css";
import "../styles/public-form.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; title: string; message: string }
  | { kind: "ready"; form: PublicForm };

const SUCCESS_MESSAGE = "Your response has been submitted successfully.";

const loadError = (error: unknown): { title: string; message: string } => {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return {
        title: "Form not available",
        message:
          "This form doesn't exist or is no longer accepting responses. Check the link with the person who shared it.",
      };
    }
    if (error.status === 429) {
      return {
        title: "Too many requests",
        message: "Please wait a few minutes and try again.",
      };
    }
    if (error.status === 0) {
      return {
        title: "Can't reach the server",
        message: "Check your connection and try again.",
      };
    }
  }

  return {
    title: "Something went wrong",
    message: "The form couldn't be loaded. Please try again.",
  };
};

/* Safe, user-facing text for a failed submit; never the server's own message. */
const submitFailure = (error: unknown): SubmitResult => {
  if (error instanceof ApiError) {
    if (error.code === "VALIDATION_ERROR") {
      return {
        ok: false,
        message: "Please fix the highlighted fields and try again.",
        fieldErrors: error.fields,
      };
    }
    if (error.status === 404) {
      return { ok: false, message: "This form is no longer accepting responses." };
    }
    if (error.status === 413) {
      return { ok: false, message: "Your answers are too large to submit." };
    }
    if (error.status === 429) {
      return {
        ok: false,
        message: "You've submitted this form too many times. Please wait a few minutes and try again.",
      };
    }
    if (error.status === 503) {
      return {
        ok: false,
        message: "Submissions are temporarily unavailable. Please try again shortly.",
      };
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
 * The page anyone with a share link sees. No sign-in, no builder or
 * account controls, nothing about the owner. It renders the CURRENT
 * published version with the shared FormRenderer and submits anonymously.
 */
export function PublicFormPage() {
  const { publicId = "" } = useParams<{ publicId: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    fetchPublicForm(publicId)
      .then((form) => {
        if (cancelled) return;
        setState({ kind: "ready", form });
        document.title = form.name || "Form";
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", ...loadError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [publicId, reloadKey]);

  const handleSubmit: FormSubmitHandler = async (values) => {
    try {
      await submitPublicForm(publicId, values);
      return { ok: true, summary: SUCCESS_MESSAGE };
    } catch (error: unknown) {
      return submitFailure(error);
    }
  };

  return (
    <div className="pf-page">
      <main className="pf-card">
        {state.kind === "loading" && (
          <p className="pf-message" role="status">
            Loading form…
          </p>
        )}

        {state.kind === "error" && (
          <div className="pf-message" role="alert">
            <h1 className="pf-title">{state.title}</h1>
            <p className="pf-text">{state.message}</p>
            <button
              type="button"
              className="fb-button"
              onClick={() => {
                setState({ kind: "loading" });
                setReloadKey((key) => key + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <header className="pf-header">
              <h1 className="pf-title">{state.form.name || "Untitled form"}</h1>
              {state.form.description && (
                <p className="pf-text">{state.form.description}</p>
              )}
            </header>
            <FormRenderer
              schema={state.form.schema}
              mode="published"
              onSubmit={handleSubmit}
            />
          </>
        )}
      </main>
      <p className="pf-footer">Never submit passwords through this form.</p>
    </div>
  );
}
