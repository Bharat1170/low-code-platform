// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
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

const PUBLISHED_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const DRAFT_ID = "665f1c2e8f1b2c3d4e5f6a7c";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const forms = [
  {
    _id: PUBLISHED_ID,
    name: "Contact form",
    status: "PUBLISHED",
    publishedVersionId: "665f1c2e8f1b2c3d4e5f6a99",
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
  },
  {
    _id: DRAFT_ID,
    name: "",
    status: "DRAFT",
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:00:00.000Z",
  },
];

const withForms =
  (respond: () => Response): Handler =>
  (method, path) => {
    if (method === "POST" && path === "/auth/refresh") return refreshOk();
    if (method === "GET" && path === "/auth/me") return meOk();
    if (method === "GET" && path.startsWith("/forms?")) return respond();
    return failure(404, "NOT_FOUND");
  };

describe("FormsPage", () => {
  it("lists the organization's forms with edit and entries links", async () => {
    const fetchMock = installFetch(withForms(() => ok({ forms })));
    renderApp("/forms");

    expect(await screen.findByText("Loading forms…")).toBeTruthy();

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);

    const published = rows[1]!;
    expect(within(published).getByText("Published")).toBeTruthy();
    expect(
      within(published)
        .getByRole("link", { name: "Edit Contact form" })
        .getAttribute("href"),
    ).toBe(`/?formId=${PUBLISHED_ID}`);
    expect(
      within(published)
        .getByRole("link", { name: "Entries for Contact form" })
        .getAttribute("href"),
    ).toBe(`/forms/${PUBLISHED_ID}/submissions`);

    // A form with no published version has nothing to collect entries for.
    const draft = rows[2]!;
    expect(within(draft).getByText("Draft")).toBeTruthy();
    expect(within(draft).getByRole("link", { name: "Edit Untitled form" })).toBeTruthy();
    expect(within(draft).queryByRole("link", { name: /^Entries/ })).toBeNull();

    // The organization is never chosen by the client.
    const listCall = fetchMock.calls.find((c) => c.path.startsWith("/forms?"));
    expect(listCall?.path).not.toContain("organization");
  });

  it("shows an empty state with a way to create a form", async () => {
    installFetch(withForms(() => ok({ forms: [] })));
    renderApp("/forms");

    expect(await screen.findByText("No forms yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a form" }).getAttribute("href")).toBe("/");
  });

  it("shows a safe error with Retry, and recovers", async () => {
    let calls = 0;
    installFetch(
      withForms(() => {
        calls += 1;
        return calls === 1
          ? failure(500, "INTERNAL_SERVER_ERROR", "Mongo exploded: secret detail")
          : ok({ forms });
      }),
    );
    renderApp("/forms");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unable to load your forms");
    expect(alert.textContent).not.toContain("secret detail");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("requires sign-in", async () => {
    installFetch(signedOutHandler);
    renderApp("/forms");

    expect(await screen.findByRole("heading", { name: /sign in/i })).toBeTruthy();
    expect(screen.queryByText("Loading forms…")).toBeNull();
  });
});
