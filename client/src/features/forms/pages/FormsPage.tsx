import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AccountMenu } from "../../auth/components/AccountMenu.tsx";
import {
  ApiError,
  listForms,
  MAX_FORMS_PAGE_SIZE,
  type FormSummary,
} from "../../form-builder/api/forms.api.ts";
import { formatDateTime } from "../../submissions/utils/submissions.format.ts";
import "../../form-builder/styles/form-builder.css";
import "../../submissions/styles/submissions.css";
import "../styles/forms.css";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; forms: FormSummary[] };

/* Safe, user-facing text; never the backend's own message. */
const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again.";
    if (error.status === 403) return "You don't have permission to view forms.";
    if (error.status === 429) return "Too many requests. Please wait a moment and try again.";
    if (error.status === 0) {
      return "Unable to reach the server. Check your connection and try again.";
    }
  }

  return "Unable to load your forms. Please try again.";
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

const builderPath = (id: string): string => `/?formId=${encodeURIComponent(id)}`;
const submissionsPath = (id: string): string =>
  `/forms/${encodeURIComponent(id)}/submissions`;

/*
 * How many of the loaded forms are published. The list is one page of up
 * to MAX_FORMS_PAGE_SIZE forms, so a full page means "at least" (shown n+).
 */
function FormsSummary({ forms }: { forms: FormSummary[] }) {
  const published = forms.filter((form) => form.status === "PUBLISHED").length;
  const more = forms.length >= MAX_FORMS_PAGE_SIZE ? "+" : "";

  return (
    <div className="forms-summary" role="group" aria-label="Form totals">
      <p className="forms-stat" data-stat="published">
        <strong className="forms-stat-value">
          {published}
          {more}
        </strong>
        <span className="forms-stat-label">published</span>
      </p>
      <p className="forms-stat" data-stat="total">
        <strong className="forms-stat-value">
          {forms.length}
          {more}
        </strong>
        <span className="forms-stat-label">total</span>
      </p>
    </div>
  );
}

/*
 * Every form of the signed-in organization, newest first. Each row opens
 * the form in the builder or lists its submissions (stored server-side
 * against the exact published version they were submitted to).
 */
export function FormsPage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    listForms()
      .then((forms) => {
        if (!cancelled) setState({ kind: "ready", forms });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return (
    <div className="sub-page">
      <header className="sub-header forms-header">
        <div>
          <h1 className="sub-title">Forms</h1>
          <p className="sub-subtitle">Forms you have created, newest first.</p>
        </div>
        <div className="forms-header-actions">
          <Link className="fb-button fb-button-primary" to="/">
            New form
          </Link>
          <AccountMenu />
        </div>
      </header>

      {state.kind === "loading" && (
        <p className="sub-message" role="status">
          Loading forms…
        </p>
      )}

      {state.kind === "error" && (
        <div className="sub-message sub-message-error" role="alert">
          <p>{state.message}</p>
          <button
            type="button"
            className="fb-button"
            onClick={() => {
              setState({ kind: "loading" });
              setReloadKey((key) => key + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {state.kind === "ready" && state.forms.length === 0 && (
        <div className="sub-message sub-empty">
          <h2>No forms yet</h2>
          <p>Create your first form to start collecting responses.</p>
          <Link className="fb-button fb-button-primary" to="/">
            Create a form
          </Link>
        </div>
      )}

      {state.kind === "ready" && state.forms.length > 0 && (
        <FormsSummary forms={state.forms} />
      )}

      {state.kind === "ready" && state.forms.length > 0 && (
        <div className="sub-table-wrap">
          <table className="sub-table">
            <caption className="sub-sr-only">Your forms, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Last updated</th>
                <th scope="col">
                  <span className="sub-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.forms.map((form) => {
                const name = form.name || "Untitled form";
                return (
                  <tr key={form.id}>
                    <td>
                      <Link className="forms-name" to={builderPath(form.id)}>
                        {name}
                      </Link>
                    </td>
                    <td>
                      <span className="forms-status" data-status={form.status}>
                        {STATUS_LABELS[form.status] ?? form.status}
                      </span>
                    </td>
                    <td>{form.createdAt ? formatDateTime(form.createdAt) : "—"}</td>
                    <td>{form.updatedAt ? formatDateTime(form.updatedAt) : "—"}</td>
                    <td className="sub-actions">
                      <Link
                        className="fb-button"
                        to={builderPath(form.id)}
                        aria-label={`Edit ${name}`}
                      >
                        Edit
                      </Link>
                      {form.hasPublishedVersion && (
                        <Link
                          className="fb-button"
                          to={submissionsPath(form.id)}
                          aria-label={`Entries for ${name}`}
                        >
                          Entries
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
