import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, fetchForm } from "../../form-builder/api/forms.api.ts";
import type { FormSchema } from "../../form-builder/types/form-builder.types.ts";
import { createEmptyFormSchema } from "../../form-builder/utils/form-schema.utils.ts";
import { isFormSchema } from "../../form-builder/utils/form-schema.validate.ts";
import { FormRenderer } from "./FormRenderer.tsx";
import "../../form-builder/styles/form-builder.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; name: string; schema: FormSchema };

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You don't have permission to preview this form.";
    if (error.status === 404 || error.status === 400) {
      return "This form was not found.";
    }
  }

  return "Unable to load the form. Please try again.";
};

/*
 * "Test User": the CURRENT DRAFT of a form, rendered with FormRenderer in
 * preview mode. It is the owner's local simulation: no onSubmit is given,
 * so answers are only validated in the browser and are never sent anywhere
 * (no submission API is called). The draft comes from the authenticated
 * form API; the route sits behind RequireAuth. The published version is
 * never read here.
 */
export function DraftPreviewPage() {
  const { formId } = useParams<{ formId: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!formId) return;
    let cancelled = false;

    fetchForm(formId)
      .then((form) => {
        if (cancelled) return;

        const name = form.name || "Untitled form";

        if (form.draftSchema === undefined || form.draftSchema === null) {
          setState({ kind: "ready", name, schema: createEmptyFormSchema() });
        } else if (isFormSchema(form.draftSchema)) {
          setState({ kind: "ready", name, schema: form.draftSchema });
        } else {
          setState({
            kind: "error",
            message: "This form's saved draft is invalid, so it can't be previewed.",
          });
        }
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

  return (
    <div className="fr-page">
      <div className="fr-banner" role="note">
        <strong>Preview Mode</strong> Your current draft is being tested.
        Responses from this screen are not stored.{" "}
        <Link to={`/?formId=${encodeURIComponent(formId ?? "")}`}>
          Back to builder
        </Link>
      </div>
      <main className="fr-card">
        <h1 className="fr-title">{state.name}</h1>
        <FormRenderer schema={state.schema} mode="preview" />
      </main>
    </div>
  );
}
