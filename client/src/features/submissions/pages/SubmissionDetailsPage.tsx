import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  getSubmission,
  type SubmissionDetails,
} from "../api/submissions.api.ts";
import { DeleteSubmissionDialog } from "../components/DeleteSubmissionDialog.tsx";
import {
  FIELD_TYPE_LABELS,
  displayValue,
  formatDateTime,
  shortId,
  submissionsErrorMessage,
  submitterLabel,
} from "../utils/submissions.format.ts";
import "../../form-builder/styles/form-builder.css";
import "../styles/submissions.css";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; notFound: boolean }
  | { kind: "ready"; submission: SubmissionDetails };

/*
 * One submission, interpreted with the schema of the version it was made
 * against (supplied by the server from the submission's own version).
 * Every value is rendered as text.
 */
export function SubmissionDetailsPage() {
  const { formId = "", submissionId = "" } = useParams<{
    formId: string;
    submissionId: string;
  }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    getSubmission(formId, submissionId)
      .then((submission) => {
        if (!cancelled) setState({ kind: "ready", submission });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? (error as { status: unknown }).status
              : undefined;
          setState({
            kind: "error",
            message: submissionsErrorMessage(error),
            notFound: status === 404,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [formId, submissionId, reloadKey]);

  // Keeps the list's page and filters when going back.
  const backTo = {
    pathname: `/forms/${encodeURIComponent(formId)}/submissions`,
    search: location.search,
  };

  const back = (
    <Link className="sub-back" to={backTo}>
      ← Back to submissions
    </Link>
  );

  if (state.kind === "loading") {
    return (
      <div className="sub-page">
        {back}
        <p className="sub-message" role="status">
          Loading submission…
        </p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="sub-page">
        {back}
        <div className="sub-message sub-message-error" role="alert">
          <p>{state.message}</p>
          {!state.notFound && (
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
          )}
        </div>
      </div>
    );
  }

  const { submission } = state;
  const fields = submission.schema?.fields ?? [];
  const known = new Set(fields.map((field) => field.id));
  const extraKeys = Object.keys(submission.data).filter((key) => !known.has(key));

  return (
    <div className="sub-page">
      {back}
      <header className="sub-header">
        <div>
          <h1 className="sub-title">Submission {shortId(submission.id)}</h1>
          {submission.formName && (
            <p className="sub-subtitle">{submission.formName}</p>
          )}
        </div>
        <button
          type="button"
          className="fb-button"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete
        </button>
      </header>

      <section className="sub-card" aria-label="Submission details">
        <dl className="sub-meta">
          <div>
            <dt>Submission ID</dt>
            <dd className="sub-mono">{submission.id}</dd>
          </div>
          <div>
            <dt>Form version</dt>
            <dd>
              <span className="sub-version">v{submission.version}</span>
            </dd>
          </div>
          <div>
            <dt>Submitted by</dt>
            <dd>
              {submitterLabel(submission.submittedBy, submission.submittedByName)}
            </dd>
          </div>
          <div>
            <dt>Submitted at</dt>
            <dd>{formatDateTime(submission.submittedAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="sub-card" aria-label="Submitted fields">
        <h2 className="sub-card-title">Submitted fields</h2>

        {submission.schema === null && (
          <p className="sub-note" role="note">
            The form definition for this version is unavailable, so field
            names are shown as stored.
          </p>
        )}

        <dl className="sub-fields">
          {fields.map((field) => (
            <div className="sub-field" key={field.id}>
              <dt>
                {field.label.trim() === "" ? field.id : field.label}
                <span className="sub-type">
                  {FIELD_TYPE_LABELS[field.type] ?? field.type}
                </span>
              </dt>
              <dd>{displayValue(field, submission.data[field.id])}</dd>
            </div>
          ))}

          {extraKeys.map((key) => (
            <div className="sub-field" key={key}>
              <dt>
                {key}
                <span className="sub-type">Not in this version</span>
              </dt>
              <dd>{displayValue(undefined, submission.data[key])}</dd>
            </div>
          ))}
        </dl>

        {fields.length === 0 && extraKeys.length === 0 && (
          <p className="sub-note">This submission has no field values.</p>
        )}
      </section>

      {confirmingDelete && (
        <DeleteSubmissionDialog
          formId={formId}
          submissionId={submission.id}
          label={shortId(submission.id)}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={(outcome) =>
            navigate(backTo, {
              replace: true,
              state: {
                notice:
                  outcome === "deleted"
                    ? "Submission deleted."
                    : "That submission no longer exists.",
              },
            })
          }
        />
      )}
    </div>
  );
}
