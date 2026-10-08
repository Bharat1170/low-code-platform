// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const textField = (id: string, label: string, required = false) => ({
  id,
  type: "TEXT",
  label,
  description: "",
  required,
  config: { placeholder: "", defaultValue: "" },
  validation: {},
  conditionalLogic: null,
});

const DRAFT = {
  version: 1,
  fields: [textField("name", "Full name", true)],
};

/* A form that has NEVER been published: no publishedVersionId, status DRAFT. */
const withDraft =
  (draftSchema: unknown = DRAFT): Handler =>
  (method, path) => {
    if (method === "POST" && path === "/auth/refresh") return refreshOk();
    if (method === "GET" && path === "/auth/me") return meOk();
    if (method === "GET" && path === `/forms/${FORM_ID}`) {
      return ok({
        form: { _id: FORM_ID, name: "Contact", status: "DRAFT", draftSchema },
      });
    }
    return failure(404, "NOT_FOUND");
  };

const formCalls = (net: ReturnType<typeof installFetch>) =>
  net.calls.filter((c) => c.path.startsWith("/forms"));

describe("draft preview (Test User)", () => {
  it("shows a loading state first", async () => {
    installFetch(withDraft());
    renderApp(`/forms/${FORM_ID}/preview`);

    expect(await screen.findByText("Loading form…")).toBeTruthy();
    await screen.findByLabelText(/Full name/);
  });

  it("works before the form is published and renders the current draft", async () => {
    const net = installFetch(withDraft());
    renderApp(`/forms/${FORM_ID}/preview`);

    expect(await screen.findByLabelText(/Full name/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contact" })).toBeTruthy();

    // Only the draft endpoint was used: never the published one.
    expect(formCalls(net).map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /forms/${FORM_ID}`,
    ]);
  });

  it("renders in preview mode with a clear Preview Mode notice", async () => {
    installFetch(withDraft());
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    expect(screen.getByRole("form", { name: "Form" }).getAttribute("data-mode")).toBe(
      "preview",
    );
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Preview Mode");
    expect(note.textContent).toContain("Your current draft is being tested");
    expect(note.textContent).toContain("Responses from this screen are not stored");
    expect(
      screen.getByRole("link", { name: "Back to builder" }).getAttribute("href"),
    ).toBe(`/?formId=${FORM_ID}`);
  });

  it("is interactive and validates", async () => {
    installFetch(withDraft());
    renderApp(`/forms/${FORM_ID}/preview`);
    const user = userEvent.setup();
    const input = (await screen.findByLabelText(/Full name/)) as HTMLInputElement;

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Please fix 1 field below.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await user.type(input, "Ada");
    expect(input.value).toBe("Ada");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("never creates a submission: a valid test submit stays local", async () => {
    const net = installFetch(withDraft());
    renderApp(`/forms/${FORM_ID}/preview`);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Full name/), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Everything looks good")).toBeTruthy();
    expect(screen.getByText(/only a test/i)).toBeTruthy();

    const writes = net.calls.filter(
      (c) => c.method !== "GET" && !c.path.startsWith("/auth"),
    );
    expect(writes).toEqual([]);
    expect(net.calls.some((c) => c.path.includes("submissions"))).toBe(false);
    expect(net.calls.some((c) => c.path.includes("published"))).toBe(false);
  });

  it("shows an empty-form message for a form with no draft yet", async () => {
    installFetch(withDraft(null));
    renderApp(`/forms/${FORM_ID}/preview`);

    expect(await screen.findByText("This form has no fields yet.")).toBeTruthy();
  });

  it("refuses an invalid saved draft instead of rendering it", async () => {
    installFetch(withDraft({ version: 1, fields: [{ id: "x", type: "NOPE" }] }));
    renderApp(`/forms/${FORM_ID}/preview`);

    expect((await screen.findByRole("alert")).textContent).toMatch(/draft is invalid/i);
  });

  it.each([
    [404, "This form was not found."],
    [403, "You don't have permission to preview this form."],
    [500, "Unable to load the form. Please try again."],
  ])("shows a safe message for a %i", async (status, message) => {
    installFetch((method, path, init) =>
      method === "GET" && path === `/forms/${FORM_ID}`
        ? failure(status, "X", "stack trace at /srv/secret.js")
        : withDraft()(method, path, init),
    );
    renderApp(`/forms/${FORM_ID}/preview`);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.textContent).not.toContain("secret.js");
  });
});

describe("draft preview route protection and navigation", () => {
  it("requires authentication and does not fetch the draft when signed out", async () => {
    const net = installFetch(signedOutHandler);
    renderApp(`/forms/${FORM_ID}/preview`);

    await screen.findByRole("heading", { name: "Sign in" });
    expect(formCalls(net)).toEqual([]);
  });

  it("opens directly (and again on refresh) by its URL while signed in", async () => {
    installFetch(withDraft());
    const first = renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);
    first.unmount();

    // A browser refresh is a fresh mount at the same URL.
    clearAccessToken();
    renderApp(`/forms/${FORM_ID}/preview`);
    await waitFor(() => expect(screen.getByLabelText(/Full name/)).toBeTruthy());
  });
});
