// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  meOk,
  ok,
  refreshOk,
  renderApp,
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

const field = (id: string, label: string) => ({
  id,
  type: "TEXT",
  label,
  description: "",
  required: false,
  config: { placeholder: "", defaultValue: "" },
  validation: {},
  conditionalLogic: null,
});

const base: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk();
  if (method === "GET" && path === "/auth/me") return meOk();
  return failure(404, "NOT_FOUND");
};

const publishedHandler = (base_: Handler): Handler => (method, path, init) => {
  if (method === "GET" && path === `/forms/${FORM_ID}/published`) {
    return ok({
      published: {
        formId: FORM_ID,
        name: "Contact",
        versionId: "665f1c2e8f1b2c3d4e5f6a99",
        version: 1,
        schema: {
          version: 1,
          fields: [{ ...field("a1", "Full name"), required: true }],
        },
        publishedAt: "2026-10-05T10:00:00.000Z",
      },
    });
  }
  return base_(method, path, init);
};

describe("published preview page (Test User)", () => {
  it("shows a loading state first", async () => {
    installFetch(publishedHandler(base));
    renderApp(`/forms/${FORM_ID}/preview`);

    expect(await screen.findByText("Loading form…")).toBeTruthy();
    await screen.findByLabelText(/Full name/);
  });

  it("validates locally and writes nothing: no submission request is made", async () => {
    const net = installFetch(publishedHandler(base));
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Full name is required")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByRole("status").textContent).toContain("nothing was saved");
    expect(net.calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/auth"))).toEqual([]);
  });

  it("renders the published version, using only the published endpoint", async () => {
    const net = installFetch((method, path, init) => {
      if (method === "GET" && path === `/forms/${FORM_ID}/published`) {
        return ok({
          published: {
            formId: FORM_ID,
            name: "Contact",
            versionId: "665f1c2e8f1b2c3d4e5f6a99",
            version: 3,
            schema: { version: 1, fields: [field("a1", "Full name")] },
            publishedAt: "2026-10-05T10:00:00.000Z",
          },
        });
      }
      return base(method, path, init);
    });

    renderApp(`/forms/${FORM_ID}/preview`);

    expect(await screen.findByLabelText("Full name")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contact" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("version 3");
    // Builder-only controls are absent; the draft endpoint is never used.
    for (const name of [/save draft/i, /publish/i, /test user/i, /sign out/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.querySelector("[data-field-number]")).toBeNull();
    expect(net.calls.some((c) => c.path === `/forms/${FORM_ID}`)).toBe(false);
    expect(
      net.calls.some((c) => c.method !== "GET" && c.path.startsWith("/forms")),
    ).toBe(false);
  });

  it("shows a clear message for a form that was never published", async () => {
    installFetch((method, path, init) => {
      if (method === "GET" && path === `/forms/${FORM_ID}/published`) {
        return failure(404, "FORM_NOT_PUBLISHED", "This form has not been published");
      }
      return base(method, path, init);
    });

    renderApp(`/forms/${FORM_ID}/preview`);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "This form hasn't been published yet.",
      ),
    );
  });
});
