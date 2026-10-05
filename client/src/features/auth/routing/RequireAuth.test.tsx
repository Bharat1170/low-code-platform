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
  signedOutHandler,
  type Handler,
} from "../testing/test-utils.tsx";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedIn: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk();
  if (method === "GET" && path === "/auth/me") return meOk();
  if (method === "POST" && path === "/auth/logout") return ok(undefined, "Logout successful");
  if (method === "GET" && path === "/forms/abc") {
    return json(200, {
      success: true,
      data: { form: { _id: "abc", name: "F", status: "DRAFT", draftSchema: null } },
    });
  }
  return failure(404, "NOT_FOUND");
};

describe("protected application", () => {
  it("blocks an unauthenticated user and shows the login page", async () => {
    installFetch(signedOutHandler);
    renderApp("/");

    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.queryByRole("heading", { name: "Form Builder" })).toBeNull();
  });

  it("blocks direct access to a form link when signed out, without calling the forms API", async () => {
    const net = installFetch(signedOutHandler);
    renderApp("/?formId=abc");

    await screen.findByRole("heading", { name: "Sign in" });
    expect(net.calls.some((c) => c.path.startsWith("/forms"))).toBe(false);
  });

  it("shows a loading state first and never flashes the app or the login page", async () => {
    let release: (response: Response) => void = () => {};
    installFetch((method, path, init) =>
      method === "POST" && path === "/auth/refresh"
        ? new Promise<Response>((resolve) => (release = resolve))
        : signedIn(method, path, init),
    );
    renderApp("/");

    expect(screen.getByRole("status").textContent).toContain("Loading...");
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Form Builder" })).toBeNull();

    release(refreshOk());
    await screen.findByRole("heading", { name: "Form Builder" });
  });

  it("lets an authenticated user in and restores the session on load", async () => {
    installFetch(signedIn);
    renderApp("/");

    await screen.findByRole("heading", { name: "Form Builder" });
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("keeps the existing ?formId flow working for a signed-in user", async () => {
    const net = installFetch(signedIn);
    renderApp("/?formId=abc");

    await screen.findByRole("heading", { name: "Form Builder" });
    expect(net.count("GET", "/forms/abc")).toBe(1);
    expect(
      (net.last("GET", "/forms/abc")?.init.headers as Record<string, string>)
        .Authorization,
    ).toBe("Bearer access-1");
    // The token from sign-in is reused: only the one bootstrap refresh.
    expect(net.count("POST", "/auth/refresh")).toBe(1);
  });

  it("redirects a signed-in user away from /login", async () => {
    installFetch(signedIn);
    renderApp("/login");

    await screen.findByRole("heading", { name: "Form Builder" });
  });

  it("signs out from the builder and returns to the login page", async () => {
    const net = installFetch(signedIn);
    renderApp("/");
    await screen.findByRole("heading", { name: "Form Builder" });

    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));

    await screen.findByRole("heading", { name: "Sign in" });
    expect(net.count("POST", "/auth/logout")).toBe(1);
    expect(screen.queryByRole("heading", { name: "Form Builder" })).toBeNull();
  });

  it("sends the user to login if the session can no longer be refreshed", async () => {
    let refreshes = 0;
    installFetch((method, path, init) => {
      if (method === "POST" && path === "/auth/refresh") {
        refreshes += 1;
        // The first refresh (bootstrap) works; later ones are rejected.
        return refreshes === 1
          ? refreshOk()
          : failure(401, "UNAUTHORIZED", "expired");
      }
      if (method === "GET" && path === "/forms/abc") {
        return failure(401, "UNAUTHORIZED", "expired token");
      }
      return signedIn(method, path, init);
    });
    renderApp("/?formId=abc");

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy(),
    );
    // One bootstrap refresh + exactly one retry-refresh: no loop.
    expect(refreshes).toBe(2);
  });
});
