// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  json,
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

  it("validates locally first: an invalid form sends nothing", async () => {
    const net = installFetch(publishedHandler(base));
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText("Full name is required")).toBeTruthy();
    expect(net.calls.some((c) => c.method === "POST" && c.path.includes("/submissions"))).toBe(false);
  });

  it("submits { data } only to the submissions endpoint and confirms", async () => {
    let releaseSubmit: () => void = () => {};
    const net = installFetch((method, path, init) => {
      if (method === "POST" && path === `/forms/${FORM_ID}/submissions`) {
        return new Promise<Response>((resolve) => {
          releaseSubmit = () =>
            resolve(
              ok({
                submission: {
                  id: "665f1c2e8f1b2c3d4e5f6aaa",
                  formId: FORM_ID,
                  formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
                  version: 1,
                  submittedAt: "2026-10-05T10:00:00.000Z",
                },
              }),
            );
        });
      }
      return publishedHandler(base)(method, path, init);
    });
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    fireEvent.click(screen.getByRole("button", { name: "Submitting…" }));

    expect((screen.getByRole("button", { name: "Submitting…" }) as HTMLButtonElement).disabled).toBe(true);
    releaseSubmit();

    expect(await screen.findByText("Response submitted")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("4e5f6aaa");
    expect(screen.getByRole("link", { name: "View submissions" }).getAttribute("href")).toBe(
      `/forms/${FORM_ID}/submissions`,
    );

    const posts = net.calls.filter((c) => c.method === "POST" && c.path.includes("/submissions"));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ data: { a1: "Ada" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit another response" }));
    expect((screen.getByLabelText(/Full name/) as HTMLInputElement).value).toBe("");
  });

  it("shows the server's per-field validation errors and keeps the entered values", async () => {
    installFetch((method, path, init) => {
      if (method === "POST" && path === `/forms/${FORM_ID}/submissions`) {
        return json(400, {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "The submission is not valid",
            fields: { a1: "Full name must be one of the allowed values" },
          },
        });
      }
      return publishedHandler(base)(method, path, init);
    });
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Full name must be one of the allowed values")).toBeTruthy();
    expect(screen.getByText("Please fix the highlighted fields and try again.")).toBeTruthy();
    expect((screen.getByLabelText(/Full name/) as HTMLInputElement).value).toBe("Ada");
  });

  it.each([
    [403, "FORBIDDEN", "don't have permission to submit"],
    [404, "FORM_NOT_PUBLISHED", "no longer published"],
    [500, "INTERNAL_SERVER_ERROR", "Unable to submit the form"],
  ])("shows a safe message for a %i response", async (status, code, expected) => {
    installFetch((method, path, init) => {
      if (method === "POST" && path === `/forms/${FORM_ID}/submissions`) {
        return failure(status, code, "Mongo exploded: secret detail");
      }
      return publishedHandler(base)(method, path, init);
    });
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(expected);
    expect(alert.textContent).not.toContain("secret detail");
    // The form stays usable for another attempt.
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a connection message when the network fails", async () => {
    installFetch((method, path, init) => {
      if (method === "POST" && path === `/forms/${FORM_ID}/submissions`) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return publishedHandler(base)(method, path, init);
    });
    renderApp(`/forms/${FORM_ID}/preview`);
    await screen.findByLabelText(/Full name/);

    fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Unable to reach the server");
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
