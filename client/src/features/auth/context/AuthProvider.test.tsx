// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  meOk,
  ok,
  refreshOk,
  signedOutHandler,
  type Handler,
} from "../testing/test-utils.tsx";
import { AuthProvider } from "./AuthProvider.tsx";
import { useAuth } from "./useAuth.ts";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  const { status, isAuthenticated, isLoading, user, organization, error, logout } =
    useAuth();

  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="flags">{`${isAuthenticated}/${isLoading}`}</p>
      <p data-testid="user">{user ? `${user.firstName} ${user.lastName}` : "none"}</p>
      <p data-testid="org">{organization?.name ?? "none"}</p>
      <p data-testid="error">{error ?? "none"}</p>
      <button type="button" onClick={() => void logout()}>
        logout
      </button>
    </div>
  );
}

const mount = (strict = false) => {
  const tree = (
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

const sessionHandler: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk("restored");
  if (method === "GET" && path === "/auth/me") return meOk();
  if (method === "POST" && path === "/auth/logout") return ok(undefined, "Logout successful");
  return failure(404, "NOT_FOUND");
};

describe("AuthProvider", () => {
  it("starts in the loading state, before the session check finishes", async () => {
    installFetch(() => new Promise<Response>(() => {}));
    mount();

    expect(screen.getByTestId("status").textContent).toBe("loading");
    expect(screen.getByTestId("flags").textContent).toBe("false/true");
  });

  it("restores the session with the refresh cookie, then loads the profile", async () => {
    const net = installFetch(sessionHandler);
    mount();

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated"),
    );

    const refresh = net.last("POST", "/auth/refresh");
    expect(refresh?.init.credentials).toBe("include");

    const me = net.last("GET", "/auth/me");
    expect((me?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer restored",
    );

    expect(screen.getByTestId("user").textContent).toBe("Ada Lovelace");
    expect(screen.getByTestId("org").textContent).toBe("Analytical Engines");
    expect(screen.getByTestId("flags").textContent).toBe("true/false");
  });

  it("becomes unauthenticated, quietly, when there is no valid session", async () => {
    installFetch(signedOutHandler);
    mount();

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("unauthenticated"),
    );
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("error").textContent).toBe("none");
  });

  it("reports a network failure while restoring, and stays signed out", async () => {
    installFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    mount();

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("unauthenticated"),
    );
    expect(screen.getByTestId("error").textContent).toMatch(/couldn't reach the server/i);
  });

  it("refreshes only once under React StrictMode (refresh tokens rotate)", async () => {
    const net = installFetch(sessionHandler);
    mount(true);

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated"),
    );
    expect(net.count("POST", "/auth/refresh")).toBe(1);
  });

  it("logout calls the API and clears all auth state", async () => {
    const net = installFetch(sessionHandler);
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated"),
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("unauthenticated"),
    );
    expect(net.count("POST", "/auth/logout")).toBe(1);
    expect(net.last("POST", "/auth/logout")?.init.credentials).toBe("include");
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("org").textContent).toBe("none");
  });

  it("logout still signs out locally when the server is unreachable", async () => {
    installFetch((method, path, init) => {
      if (method === "POST" && path === "/auth/logout") {
        throw new TypeError("Failed to fetch");
      }
      return sessionHandler(method, path, init);
    });
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("authenticated"),
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() =>
      expect(screen.getByTestId("status").textContent).toBe("unauthenticated"),
    );
  });

  it("useAuth fails clearly outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
    spy.mockRestore();
  });
});
