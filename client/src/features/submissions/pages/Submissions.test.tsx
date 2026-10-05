// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  meOk,
  ok,
  refreshOk,
  renderApp,
  signedOutHandler,
  type Handler,
} from "../../auth/testing/test-utils.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const SUB_ID = "665f1c2e8f1b2c3d4e5f6aaa";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (n: number, version = 1) => ({
  id: `665f1c2e8f1b2c3d4e5f6a${String(n).padStart(2, "0")}`,
  formId: FORM_ID,
  formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
  version,
  submittedBy: "665f1c2e8f1b2c3d4e5f6a01",
  submittedByName: n === 2 ? null : "Ada Lovelace",
  submittedAt: "2026-10-05T10:00:00.000Z",
});

const page = (items: unknown[], overrides: Record<string, number> = {}) =>
  ok({
    items,
    pagination: { page: 1, pageSize: 25, total: items.length, totalPages: 1, ...overrides },
  });

const base: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk();
  if (method === "GET" && path === "/auth/me") return meOk();
  if (method === "GET" && path === `/forms/${FORM_ID}`) {
    return ok({ form: { _id: FORM_ID, name: "Contact form", status: "PUBLISHED" } });
  }
  return failure(404, "NOT_FOUND");
};

const withList =
  (respond: (path: string) => Response | Promise<Response>): Handler =>
  (method, path, init) => {
    if (method === "GET" && path.startsWith(`/forms/${FORM_ID}/submissions`)) {
      return respond(path);
    }
    return base(method, path, init);
  };

const listUrl = `/forms/${FORM_ID}/submissions`;

describe("SubmissionsPage", () => {
  it("shows a loading state, then the submissions table", async () => {
    installFetch(withList(() => page([item(1), item(2)])));
    renderApp(listUrl);

    expect(await screen.findByText("Loading submissions…")).toBeTruthy();

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getAllByText("Ada Lovelace")).toHaveLength(1);
    expect(within(table).getByText("Unknown user")).toBeTruthy();
    expect(within(table).getAllByText("v1")).toHaveLength(2);
    expect(await screen.findByText("Contact form")).toBeTruthy();
    expect(screen.getByText("Page 1 of 1 · 2 submissions")).toBeTruthy();
  });

  it("shows an empty state", async () => {
    installFetch(withList(() => page([])));
    renderApp(listUrl);

    expect(await screen.findByText("No submissions yet")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a safe error with Retry, and recovers", async () => {
    let calls = 0;
    installFetch(
      withList(() => {
        calls += 1;
        return calls === 1
          ? failure(500, "INTERNAL_SERVER_ERROR", "Mongo exploded: secret detail")
          : page([item(1)]);
      }),
    );
    renderApp(listUrl);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unable to load submissions");
    expect(alert.textContent).not.toContain("secret detail");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("explains a 403", async () => {
    installFetch(withList(() => failure(403, "FORBIDDEN")));
    renderApp(listUrl);

    expect((await screen.findByRole("alert")).textContent).toContain("don't have permission");
  });

  it("paginates with Previous and Next, disabling them at the ends", async () => {
    const net = installFetch(
      withList((path) => {
        const n = Number(new URL(path, "http://x").searchParams.get("page") ?? "1");
        return page([item(n)], { page: n, total: 50, totalPages: 2 });
      }),
    );
    renderApp(listUrl);
    await screen.findByRole("table");

    const prev = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    fireEvent.click(next);

    await screen.findByText("Page 2 of 2 · 50 submissions");
    expect(net.calls.some((c) => c.path.includes("page=2"))).toBe(true);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends validated filters and can clear them", async () => {
    const net = installFetch(withList(() => page([item(1)])));
    renderApp(listUrl);
    await screen.findByRole("table");

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((await screen.findByRole("alert")).textContent).toContain("whole number");

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(net.calls.some((c) => c.path.includes("version=2") && c.path.includes("submittedFrom=2026-01-01"))).toBe(true),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear" })).toBeNull());
  });

  it("rejects a start date after the end date without calling the API", async () => {
    const net = installFetch(withList(() => page([item(1)])));
    renderApp(listUrl);
    await screen.findByRole("table");
    const before = net.calls.length;

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect((await screen.findByRole("alert")).textContent).toContain("must not be after");
    expect(net.calls.length).toBe(before);
  });

  it("shows a filtered empty state", async () => {
    installFetch(withList((path) => (path.includes("version=9") ? page([]) : page([item(1)]))));
    renderApp(`${listUrl}?version=9`);

    expect(await screen.findByText("No matching submissions")).toBeTruthy();
  });

  it("navigates to the details page and back, keeping the list's page", async () => {
    installFetch(
      withList((path) =>
        path.includes(`/submissions/${item(1).id}`)
          ? ok({ submission: { ...item(1), formName: "Contact form", data: {}, schema: null } })
          : page([item(1)], { page: 2, total: 40, totalPages: 2 }),
      ),
    );
    renderApp(`${listUrl}?page=2`);

    fireEvent.click(await screen.findByRole("link", { name: `View submission ${item(1).id.slice(-8)}` }));

    expect(await screen.findByRole("heading", { name: `Submission ${item(1).id.slice(-8)}` })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /Back to submissions/ }));

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(screen.getByText(/Page 2 of 2/)).toBeTruthy();
  });

  it("is protected by authentication", async () => {
    installFetch(signedOutHandler);
    renderApp(listUrl);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});

const field = (id: string, type: string, label: string, config: unknown) => ({
  id,
  type,
  label,
  description: "",
  required: false,
  config,
  validation: {},
  conditionalLogic: null,
});

const detailsBody = (data: Record<string, string | boolean>, fields: unknown[] | null) =>
  ok({
    submission: {
      id: SUB_ID,
      formId: FORM_ID,
      formName: "Contact form",
      formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
      version: 1,
      data,
      submittedBy: "665f1c2e8f1b2c3d4e5f6a01",
      submittedByName: "Ada Lovelace",
      submittedAt: "2026-10-05T10:00:00.000Z",
      schema: fields === null ? null : { version: 1, fields },
    },
  });

const detailsUrl = `${listUrl}/${SUB_ID}`;

const mountDetails = (response: Response | (() => Response)) => {
  installFetch(withList(() => (typeof response === "function" ? response() : response)));
  renderApp(detailsUrl);
};

describe("SubmissionDetailsPage", () => {
  it("shows metadata and labelled values by field type", async () => {
    mountDetails(
      detailsBody(
        { name: "Bharat", country: "in", terms: true, newsletter: false },
        [
          field("name", "TEXT", "Customer Name", { placeholder: "", defaultValue: "" }),
          field("country", "DROPDOWN", "Country", {
            placeholder: "",
            options: [{ label: "India", value: "in" }],
            defaultValue: "",
          }),
          field("terms", "CHECKBOX", "Accepted terms", { defaultValue: false }),
          field("newsletter", "CHECKBOX", "Newsletter", { defaultValue: false }),
          field("note", "TEXT", "Notes", { placeholder: "", defaultValue: "" }),
        ],
      ),
    );

    expect(await screen.findByText("Customer Name")).toBeTruthy();
    expect(screen.getByText("Bharat")).toBeTruthy();
    expect(screen.getByText("India (in)")).toBeTruthy();
    expect(screen.getByText("Accepted terms").closest("div")?.textContent).toContain("Yes");
    expect(screen.getByText("Newsletter").closest("div")?.textContent).toContain("No");
    // An optional field that was left out.
    expect(screen.getByText("Notes").closest("div")?.textContent).toContain("—");
    expect(screen.getByText(SUB_ID)).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getAllByText("Checkbox", { selector: ".sub-type" })).toHaveLength(2);
  });

  it("uses the labels of the version it was submitted against", async () => {
    // The server sends the submission's own version schema ("Customer Name").
    mountDetails(
      detailsBody({ name: "Bharat" }, [
        field("name", "TEXT", "Customer Name", { placeholder: "", defaultValue: "" }),
      ]),
    );

    expect(await screen.findByText("Customer Name")).toBeTruthy();
    expect(screen.queryByText("Full Name")).toBeNull();
  });

  it("still shows values for fields that no longer exist in the schema", async () => {
    mountDetails(
      detailsBody({ name: "Bharat", legacy: "kept" }, [
        field("name", "TEXT", "Customer Name", { placeholder: "", defaultValue: "" }),
      ]),
    );

    expect(await screen.findByText("legacy")).toBeTruthy();
    expect(screen.getByText("kept")).toBeTruthy();
    expect(screen.getByText("Not in this version")).toBeTruthy();
  });

  it("degrades gracefully when the schema is unavailable", async () => {
    mountDetails(detailsBody({ name: "Bharat" }, null));

    expect(await screen.findByRole("note")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("Bharat")).toBeTruthy();
  });

  it("renders HTML-looking values as text, and handles very long values", async () => {
    const xss = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    const long = "x".repeat(5000);
    mountDetails(
      detailsBody({ name: xss, note: long }, [
        field("name", "TEXT", "<b>Label</b>", { placeholder: "", defaultValue: "" }),
        field("note", "TEXT", "Note", { placeholder: "", defaultValue: "" }),
      ]),
    );

    expect(await screen.findByText(xss)).toBeTruthy();
    expect(screen.getByText("<b>Label</b>", { exact: false })).toBeTruthy();
    expect(document.querySelector(".sub-page script")).toBeNull();
    expect(document.querySelector(".sub-page img")).toBeNull();
    expect(document.querySelector(".sub-page b")).toBeNull();
    expect(screen.getByText(long)).toBeTruthy();
  });

  it("shows a loading state first", async () => {
    mountDetails(detailsBody({}, []));
    expect(await screen.findByText("Loading submission…")).toBeTruthy();
    await screen.findByText("This submission has no field values.");
  });

  it("shows not-found without a retry button", async () => {
    mountDetails(() => failure(404, "SUBMISSION_NOT_FOUND"));

    expect((await screen.findByRole("alert")).textContent).toContain("not found");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows an unauthorized message for 403", async () => {
    mountDetails(() => failure(403, "FORBIDDEN"));

    expect((await screen.findByRole("alert")).textContent).toContain("don't have permission");
  });

  it("shows a generic error with Retry, without backend details", async () => {
    mountDetails(() => failure(500, "INTERNAL_SERVER_ERROR", "stack trace here"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("stack trace");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
