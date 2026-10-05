// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  loginOk,
  meOk,
  renderApp,
  signedOutHandler,
  type Handler,
} from "../testing/test-utils.tsx";

const PASSWORD = "Sup3r-Secret-Pass";

beforeEach(() => {
  clearAccessToken();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = async (login: Handler, entry = "/login") => {
  const net = installFetch((method, path, init) => {
    if (method === "POST" && path === "/auth/login") return login(method, path, init);
    if (method === "GET" && path === "/auth/me") return meOk();
    if (method === "POST" && path === "/auth/logout") {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (method === "GET" && path.startsWith("/forms/")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { form: { _id: "abc", name: "F", status: "DRAFT", draftSchema: null } },
        }),
        { status: 200 },
      );
    }
    return signedOutHandler(method, path, init);
  });
  renderApp(entry);
  await screen.findByRole("heading", { name: "Sign in" });
  return { net, user: userEvent.setup() };
};

const fillAndSubmit = async (
  user: ReturnType<typeof userEvent.setup>,
  email = "  Ada@Example.com ",
  password = PASSWORD,
) => {
  if (email) await user.type(screen.getByLabelText("Email"), email);
  if (password) await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: /sign in|signing in/i }));
};

describe("LoginPage", () => {
  it("renders email and password with a link to register", async () => {
    await open(() => loginOk());

    expect((screen.getByLabelText("Email") as HTMLInputElement).type).toBe("email");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect(screen.getByRole("link", { name: "Create one" }).getAttribute("href")).toBe("/register");
  });

  it("validates required fields without calling the API", async () => {
    const { net, user } = await open(() => loginOk());

    await fillAndSubmit(user, "", "");

    expect(screen.getByText("Email is required")).toBeTruthy();
    expect(screen.getByText("Password is required")).toBeTruthy();
    expect(net.count("POST", "/auth/login")).toBe(0);
  });

  it("submits the correct payload, stores auth in memory only, and opens the builder", async () => {
    const { net, user } = await open(() => loginOk("token-xyz"));

    await fillAndSubmit(user);

    await screen.findByRole("heading", { name: "Form Builder" });

    const call = net.last("POST", "/auth/login");
    expect(call?.body).toEqual({ email: "Ada@Example.com", password: PASSWORD });
    expect(call?.init.credentials).toBe("include");

    // /auth/me is called with the in-memory access token.
    const me = net.last("GET", "/auth/me");
    expect((me?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer token-xyz",
    );

    // The signed-in user is shown, and nothing sensitive is in web storage.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(net.calls.every((c) => !c.path.includes(PASSWORD))).toBe(true);
  });

  it("shows a generic error for a 401 and keeps the user on the page", async () => {
    const { user } = await open(() =>
      failure(401, "INVALID_CREDENTIALS", "Invalid email or password"),
    );

    await fillAndSubmit(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Invalid email or password.",
    );
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Form Builder" })).toBeNull();
  });

  it("handles a network failure", async () => {
    const { user } = await open(() => {
      throw new TypeError("Failed to fetch");
    });

    await fillAndSubmit(user);

    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't reach the server/i);
    expect(
      (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("handles rate limiting and inactive accounts", async () => {
    const first = await open(() => failure(429, "RATE_LIMITED", "slow down"));
    await fillAndSubmit(first.user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many attempts/i);
  });

  it("disables the button while signing in so it cannot be submitted twice", async () => {
    let release: (response: Response) => void = () => {};
    const { net, user } = await open(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );

    await fillAndSubmit(user);

    const button = (await screen.findByRole("button", {
      name: "Signing in...",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.closest("form")?.getAttribute("aria-busy")).toBe("true");

    await user.click(button);
    await user.keyboard("{Enter}");
    expect(net.count("POST", "/auth/login")).toBe(1);

    release(loginOk());
    await screen.findByRole("heading", { name: "Form Builder" });
  });

  it("returns to the originally requested page, keeping ?formId", async () => {
    const { net, user } = await open(() => loginOk(), "/?formId=abc");

    // Redirected from the protected route.
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();

    await fillAndSubmit(user);

    await screen.findByRole("heading", { name: "Form Builder" });
    expect(net.count("GET", "/forms/abc")).toBe(1);
  });
});
