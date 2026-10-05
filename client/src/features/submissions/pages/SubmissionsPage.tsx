import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { fetchForm } from "../../form-builder/api/forms.api.ts";
import {
  listSubmissions,
  type SubmissionList,
} from "../api/submissions.api.ts";
import {
  formatDateTime,
  shortId,
  submissionsErrorMessage,
} from "../utils/submissions.format.ts";
import "../../form-builder/styles/form-builder.css";
import "../styles/submissions.css";

const PAGE_SIZE = 25;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string; key: string }
  | { kind: "ready"; list: SubmissionList; key: string };

/* The URL is the source of truth, so refresh and Back keep the view. */
const readPage = (value: string | null): number => {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
};

const readVersion = (value: string | null): number | undefined => {
  const version = Number(value);
  return value !== null && Number.isInteger(version) && version >= 1
    ? version
    : undefined;
};

const readDate = (value: string | null): string | undefined =>
  value !== null && DATE_ONLY.test(value) ? value : undefined;

export function SubmissionsPage() {
  const { formId = "" } = useParams<{ formId: string }>();
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [formName, setFormName] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const page = readPage(params.get("page"));
  const version = readVersion(params.get("version"));
  const from = readDate(params.get("from"));
  const to = readDate(params.get("to"));

  // Identifies the request this view belongs to. While it differs from the
  // loaded one, the previous page stays visible and is marked busy.
  const requestKey = [formId, page, version, from, to, reloadKey].join("|");

  const [versionDraft, setVersionDraft] = useState(version?.toString() ?? "");
  const [fromDraft, setFromDraft] = useState(from ?? "");
  const [toDraft, setToDraft] = useState(to ?? "");
  const [filterError, setFilterError] = useState<string | null>(null);

  // Context only; a failure here must not block the list.
  useEffect(() => {
    let cancelled = false;
    fetchForm(formId)
      .then((form) => {
        if (!cancelled) setFormName(form.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [formId]);

  useEffect(() => {
    let cancelled = false;

    listSubmissions(formId, {
      page,
      pageSize: PAGE_SIZE,
      version,
      submittedFrom: from,
      submittedTo: to,
    })
      .then((list) => {
        if (!cancelled) setState({ kind: "ready", list, key: requestKey });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: submissionsErrorMessage(error),
            key: requestKey,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestKey, formId, page, version, from, to, reloadKey]);

  const go = (next: Record<string, string | undefined>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") merged.delete(key);
      else merged.set(key, value);
    }
    setParams(merged);
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    const versionText = versionDraft.trim();

    if (versionText !== "" && readVersion(versionText) === undefined) {
      setFilterError("Version must be a whole number of 1 or more.");
      return;
    }
    if (fromDraft !== "" && toDraft !== "" && fromDraft > toDraft) {
      setFilterError("The start date must not be after the end date.");
      return;
    }

    setFilterError(null);
    go({ version: versionText, from: fromDraft, to: toDraft, page: undefined });
  };

  const clearFilters = () => {
    setVersionDraft("");
    setFromDraft("");
    setToDraft("");
    setFilterError(null);
    go({ version: undefined, from: undefined, to: undefined, page: undefined });
  };

  const filtered = version !== undefined || from !== undefined || to !== undefined;
  const detailsSearch = params.toString();

  return (
    <div className="sub-page">
      <header className="sub-header">
        <div>
          <Link className="sub-back" to={`/?formId=${encodeURIComponent(formId)}`}>
            ← Back to builder
          </Link>
          <h1 className="sub-title">Submissions</h1>
          {formName && <p className="sub-subtitle">{formName}</p>}
        </div>
      </header>

      <form className="sub-filters" onSubmit={applyFilters} aria-label="Filter submissions">
        <label className="sub-filter">
          <span>Version</span>
          <input
            className="fb-control"
            inputMode="numeric"
            value={versionDraft}
            onChange={(e) => setVersionDraft(e.target.value)}
            placeholder="Any"
          />
        </label>
        <label className="sub-filter">
          <span>From</span>
          <input
            className="fb-control"
            type="date"
            value={fromDraft}
            onChange={(e) => setFromDraft(e.target.value)}
          />
        </label>
        <label className="sub-filter">
          <span>To</span>
          <input
            className="fb-control"
            type="date"
            value={toDraft}
            onChange={(e) => setToDraft(e.target.value)}
          />
        </label>
        <div className="sub-filter-actions">
          <button type="submit" className="fb-button fb-button-primary">
            Apply
          </button>
          {filtered && (
            <button type="button" className="fb-button" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
        {filterError && (
          <p className="sub-filter-error" role="alert">
            {filterError}
          </p>
        )}
      </form>

      {(state.kind === "loading" ||
        (state.kind === "error" && state.key !== requestKey)) && (
        <p className="sub-message" role="status">
          Loading submissions…
        </p>
      )}

      {state.kind === "error" && state.key === requestKey && (
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

      {state.kind === "ready" && state.list.items.length === 0 && (
        <div className="sub-message sub-empty">
          <h2>{filtered ? "No matching submissions" : "No submissions yet"}</h2>
          <p>
            {filtered
              ? "Try changing or clearing the filters."
              : "Submissions will appear here once people submit this form."}
          </p>
        </div>
      )}

      {state.kind === "ready" && state.list.items.length > 0 && (
        <>
          <div
            className="sub-table-wrap"
            aria-busy={state.key !== requestKey}
            data-busy={state.key !== requestKey ? "true" : undefined}
          >
            <table className="sub-table">
              <caption className="sub-sr-only">Submissions, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Submission</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Version</th>
                  <th scope="col">Submitted by</th>
                  <th scope="col">
                    <span className="sub-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.list.items.map((item) => (
                  <tr key={item.id}>
                    <td className="sub-mono" title={item.id}>
                      {shortId(item.id)}
                    </td>
                    <td>{formatDateTime(item.submittedAt)}</td>
                    <td>
                      <span className="sub-version">v{item.version}</span>
                    </td>
                    <td>{item.submittedByName ?? "Unknown user"}</td>
                    <td className="sub-actions">
                      <Link
                        className="fb-button"
                        to={{
                          pathname: `/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(item.id)}`,
                          search: detailsSearch ? `?${detailsSearch}` : "",
                        }}
                        aria-label={`View submission ${shortId(item.id)}`}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <nav className="sub-pagination" aria-label="Pagination">
            <p className="sub-pagination-info">
              Page {state.list.pagination.page} of{" "}
              {Math.max(state.list.pagination.totalPages, 1)} ·{" "}
              {state.list.pagination.total}{" "}
              {state.list.pagination.total === 1 ? "submission" : "submissions"}
            </p>
            <div className="sub-pagination-buttons">
              <button
                type="button"
                className="fb-button"
                onClick={() => go({ page: String(page - 1) })}
                disabled={page <= 1}
              >
                Previous
              </button>
              <button
                type="button"
                className="fb-button"
                onClick={() => go({ page: String(page + 1) })}
                disabled={page >= state.list.pagination.totalPages}
              >
                Next
              </button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
