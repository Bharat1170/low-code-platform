import { useRef, useState } from "react";
import { ApiError, exportSubmissionsCsv } from "../api/submissions.api.ts";

/* Saves a downloaded file in the browser; replaceable in tests. */
export type SaveFile = (blob: Blob, filename: string) => void;

const saveWithLink: SaveFile = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const exportErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has expired. Please sign in again.";
    if (error.status === 403) return "You don't have permission to export these submissions.";
    if (error.status === 404) return "This form was not found.";
    if (error.status === 429) return "Too many requests. Please wait a moment and try again.";
    if (error.status === 0) return "Unable to reach the server. Check your connection and try again.";
  }
  return "Unable to export submissions. Please try again.";
};

interface ExportCsvButtonProps {
  formId: string;
  saveFile?: SaveFile;
}

/*
 * Downloads every submission of the form (newest first, up to the server's
 * cap) as a CSV the server builds. Filters on the page do not apply.
 */
export function ExportCsvButton({ formId, saveFile = saveWithLink }: ExportCsvButtonProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "note"; text: string } | null>(
    null,
  );
  const busyRef = useRef(false);

  const handleClick = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);

    try {
      const file = await exportSubmissionsCsv(formId);
      saveFile(file.blob, file.filename);
      if (file.truncated) {
        setMessage({
          kind: "note",
          text: "Only the newest 10,000 submissions were exported.",
        });
      }
    } catch (error: unknown) {
      setMessage({ kind: "error", text: exportErrorMessage(error) });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="sub-export">
      <button
        type="button"
        className="fb-button"
        onClick={() => void handleClick()}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? "Exporting…" : "Export CSV"}
      </button>
      {message && (
        <p
          className={message.kind === "error" ? "sub-export-error" : "sub-export-note"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
