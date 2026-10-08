// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken, setAccessToken } from "../../../lib/http.ts";
import { failure, installFetch } from "../../auth/testing/test-utils.tsx";
import { ExportCsvButton, type SaveFile } from "./ExportCsvButton.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const EXPORT = `/forms/${FORM_ID}/submissions/export`;

beforeEach(() => {
  clearAccessToken();
  setAccessToken("access-1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const csvResponse = (truncated = false) =>
  new Response("﻿Submitted at,Version\r\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="contact-submissions.csv"',
      "X-Export-Truncated": truncated ? "true" : "false",
    },
  });

describe("ExportCsvButton", () => {
  it("downloads the server's CSV with its filename, sending the access token", async () => {
    const fetchMock = installFetch((method, path) =>
      method === "GET" && path === EXPORT ? csvResponse() : failure(404, "NOT_FOUND"),
    );
    const saveFile = vi.fn<SaveFile>();
    const user = userEvent.setup();
    render(<ExportCsvButton formId={FORM_ID} saveFile={saveFile} />);

    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const [blob, filename] = saveFile.mock.calls[0]!;
    expect(filename).toBe("contact-submissions.csv");
    expect(await blob.text()).toContain("Submitted at,Version");
    const headers = fetchMock.last("GET", EXPORT)?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("notes a truncated export", async () => {
    installFetch(() => csvResponse(true));
    const user = userEvent.setup();
    render(<ExportCsvButton formId={FORM_ID} saveFile={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(await screen.findByText(/Only the newest 10,000 submissions/)).toBeTruthy();
  });

  it("shows a safe error and saves nothing on failure", async () => {
    installFetch(() => failure(403, "FORBIDDEN", "internal detail"));
    const saveFile = vi.fn<SaveFile>();
    const user = userEvent.setup();
    render(<ExportCsvButton formId={FORM_ID} saveFile={saveFile} />);

    await user.click(screen.getByRole("button", { name: "Export CSV" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("don't have permission");
    expect(alert.textContent).not.toContain("internal detail");
    expect(saveFile).not.toHaveBeenCalled();
  });
});
