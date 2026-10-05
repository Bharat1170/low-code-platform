import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import App from "../../../App.tsx";
import { API_BASE_URL } from "../../../lib/http.ts";
import { AuthProvider } from "../context/AuthProvider.tsx";

/*
 * Test helpers. The real client code runs unmodified; only the network
 * (fetch) is replaced, so no auth logic is faked.
 */

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const ok = (data?: unknown, message = "ok"): Response =>
  json(200, { success: true, message, data });

export const failure = (
  status: number,
  code: string,
  message = "Server message",
  fields: Record<string, string> = {},
): Response => json(status, { success: false, error: { code, message, fields } });

export const USER = {
  id: "665f1c2e8f1b2c3d4e5f6a01",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  organizationId: "665f1c2e8f1b2c3d4e5f6a02",
};

export const ORGANIZATION = {
  id: USER.organizationId,
  name: "Analytical Engines",
};

export const refreshOk = (token = "access-1"): Response =>
  ok({ accessToken: token, expiresAt: "2099-01-01T00:00:00.000Z" });

export const meOk = (): Response => ok({ user: USER, organization: ORGANIZATION });

export const loginOk = (token = "access-login"): Response =>
  ok({ accessToken: token, expiresAt: "2099-01-01T00:00:00.000Z", user: USER });

export type Handler = (
  method: string,
  path: string,
  init: RequestInit,
) => Response | Promise<Response>;

export interface RecordedCall {
  method: string;
  path: string;
  init: RequestInit;
  body: unknown;
}

/* Replaces fetch with a handler keyed on method + API path. */
export const installFetch = (handler: Handler) => {
  const calls: RecordedCall[] = [];

  const mock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(API_BASE_URL, "");
    calls.push({
      method,
      path,
      init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return handler(method, path, init);
  });

  vi.stubGlobal("fetch", mock);

  return {
    mock,
    calls,
    count: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path).length,
    last: (method: string, path: string) =>
      [...calls].reverse().find((c) => c.method === method && c.path === path),
  };
};

/* A signed-out browser: refresh has no cookie. */
export const signedOutHandler: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") {
    return failure(401, "UNAUTHORIZED", "Refresh token is required");
  }
  return failure(404, "NOT_FOUND");
};

export const renderApp = (
  entry: string,
  options: { strict?: boolean } = {},
) => {
  const tree = (
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
};
