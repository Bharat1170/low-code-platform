// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const PUBLIC_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
const path = `/f/${PUBLIC_ID}`;

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const field = (overrides: Record<string, unknown>) => ({
  description: "",
  required: false,
  validation: {},
  conditionalLogic: null,
  ...overrides,
});

const form = {
  name: "Customer feedback",
  description: "Two minutes, promise.",
  version: 2,
  schema: {
    version: 1,
    fields: [
      field({
        id: "name",
        type: "TEXT",
        label: "Name",
        required: true,
        config: { placeholder: "", defaultValue: "" },
      }),
      field({
        id: "email",
        type: "EMAIL",
        label: "Email",
        config: { placeholder: "", defaultValue: "" },
      }),
    ],
  },
};

/* A browser with no session at all: refresh fails. */
const anonymous =
  (submit: Handler = () => ok({ submission: { submittedAt: "2026-10-08T10:00:00.000Z" } }, "ok")): Handler =>
  (method, p, init) => {
    if (method === "POST" && p === "/auth/refresh") return failure(401, "UNAUTHORIZED");
    if (method === "GET" && p === `/public/forms/${PUBLIC_ID}`) return ok({ form });
    if (method === "POST" && p === `/public/forms/${PUBLIC_ID}/submissions`) {
      return submit(method, p, init);
    }
    return failure(404, "NOT_FOUND");
  };

describe("PublicFormPage", () => {
  it("renders the published form for a signed-out visitor, without a login screen", async () => {
    installFetch(anonymous());
    renderApp(path);

    expect(await screen.findByRole("heading", { name: "Customer feedback" })).toBeTruthy();
    expect(screen.getByText("Two minutes, promise.")).toBeTruthy();
    expect(screen.getByLabelText(/Name/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /sign in/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    expect(screen.queryByText(/submissions/i)).toBeNull();
  });

  it("submits anonymously with exactly { data } and no Authorization header", async () => {
    const fetchMock = installFetch(anonymous());
    const user = userEvent.setup();
    renderApp(path);

    await user.type(await screen.findByLabelText(/Name/), "Ada");
    await user.type(screen.getByLabelText(/Email/), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(
      await screen.findByText("Your response has been submitted successfully."),
    ).toBeTruthy();

    const call = fetchMock.last("POST", `/public/forms/${PUBLIC_ID}/submissions`);
    expect(call?.body).toEqual({ data: { name: "Ada", email: "ada@example.com" } });
    const headers = (call?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("validates on the client before sending", async () => {
    const fetchMock = installFetch(anonymous());
    const user = userEvent.setup();
    renderApp(path);

    await screen.findByLabelText(/Name/);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Name is required")).toBeTruthy();
    expect(fetchMock.count("POST", `/public/forms/${PUBLIC_ID}/submissions`)).toBe(0);
  });

  it("shows server field errors and the 429 message", async () => {
    let calls = 0;
    installFetch(
      anonymous(() => {
        calls += 1;
        return calls === 1
          ? json(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "x", fields: { email: "Email must be a valid email address" } },
            })
          : failure(429, "RATE_LIMIT_EXCEEDED");
      }),
    );
    const user = userEvent.setup();
    renderApp(path);

    await user.type(await screen.findByLabelText(/Name/), "Ada");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Email must be a valid email address")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(/submitted this form too many times/)).toBeTruthy();
  });

  it("explains an unavailable form without leaking details", async () => {
    installFetch((method, p) => {
      if (method === "POST" && p === "/auth/refresh") return failure(401, "UNAUTHORIZED");
      return failure(404, "FORM_NOT_FOUND", "secret internal detail");
    });
    renderApp(path);

    expect(await screen.findByRole("heading", { name: "Form not available" })).toBeTruthy();
    expect(screen.queryByText(/secret internal detail/)).toBeNull();
  });

  it("never requests a malformed id", async () => {
    const fetchMock = installFetch(anonymous());
    renderApp("/f/not-a-valid-id");

    expect(await screen.findByRole("heading", { name: "Form not available" })).toBeTruthy();
    expect(fetchMock.calls.some((c) => c.path.startsWith("/public/"))).toBe(false);
  });

  it("stays open (no redirect) for a signed-in owner too", async () => {
    installFetch((method, p, init) => {
      if (method === "POST" && p === "/auth/refresh") return refreshOk();
      if (method === "GET" && p === "/auth/me") return meOk();
      return anonymous()(method, p, init);
    });
    renderApp(path);

    expect(await screen.findByRole("heading", { name: "Customer feedback" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Form Builder/)).toBeNull());
  });
});
