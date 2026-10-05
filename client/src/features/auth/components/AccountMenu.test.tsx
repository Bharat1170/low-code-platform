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
} from "../testing/test-utils.tsx";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sessionHandler: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk("restored");
  if (method === "GET" && path === "/auth/me") return meOk();
  if (method === "POST" && path === "/auth/logout") {
    return ok(undefined, "Logout successful");
  }
  return failure(404, "NOT_FOUND");
};

const signOutButton = () => screen.findByRole("button", { name: "Sign out" });
const signedOut = () =>
  waitFor(() =>
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy(),
  );

describe("Sign out", () => {
  it("calls logout, clears auth state and redirects to the login page", async () => {
    const net = installFetch(sessionHandler);
    renderApp("/");

    fireEvent.click(await signOutButton());

    await signedOut();
    expect(net.count("POST", "/auth/logout")).toBe(1);
    expect(net.last("POST", "/auth/logout")?.init.credentials).toBe("include");
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Form Builder" })).toBeNull();
  });

  it("shows Signing out... and sends one request for a double click", async () => {
    let release!: () => void;
    const net = installFetch(async (method, path, init) => {
      if (method === "POST" && path === "/auth/logout") {
        await new Promise<void>((res) => (release = res));
        return ok(undefined, "Logout successful");
      }
      return sessionHandler(method, path, init);
    });
    renderApp("/");

    const button = await signOutButton();
    fireEvent.click(button);
    fireEvent.click(button);

    const busy = await screen.findByRole("button", { name: "Signing out..." });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(net.count("POST", "/auth/logout")).toBe(1);
    release();
    await signedOut();
  });

  it("still signs out and redirects when the server is unreachable", async () => {
    installFetch((method, path, init) => {
      if (method === "POST" && path === "/auth/logout") {
        throw new TypeError("Failed to fetch");
      }
      return sessionHandler(method, path, init);
    });
    renderApp("/");

    fireEvent.click(await signOutButton());

    await signedOut();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });
});
