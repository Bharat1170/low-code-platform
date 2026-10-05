// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  json,
  renderApp,
  signedOutHandler,
  type Handler,
} from "../testing/test-utils.tsx";

const PASSWORD = "Sup3r-Secret-Pass";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const registerOk = () =>
  json(201, {
    success: true,
    message: "Registration successful.",
    data: {
      userId: "665f1c2e8f1b2c3d4e5f6a01",
      organizationId: "665f1c2e8f1b2c3d4e5f6a02",
      email: "ada@example.com",
    },
  });

const open = async (register: Handler = () => registerOk()) => {
  const net = installFetch((method, path, init) =>
    method === "POST" && path === "/auth/register"
      ? register(method, path, init)
      : signedOutHandler(method, path, init),
  );
  renderApp("/register");
  await screen.findByRole("heading", { name: "Create your account" });
  return { net, user: userEvent.setup() };
};

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  overrides: Partial<Record<string, string>> = {},
) => {
  const values: Record<string, string> = {
    "First name": "Ada",
    "Last name": "Lovelace",
    Email: "ada@example.com",
    Password: PASSWORD,
    "Organization name": "Analytical Engines",
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) {
    if (value !== "") await user.type(screen.getByLabelText(label), value);
  }
};

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: /create account|registering/i }));

describe("RegisterPage", () => {
  it("renders all required fields and a link to sign in", async () => {
    await open();

    for (const label of [
      "First name",
      "Last name",
      "Email",
      "Password",
      "Organization name",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("validates required fields without calling the API", async () => {
    const { net, user } = await open();

    await submit(user);

    expect(screen.getByText("First name is required")).toBeTruthy();
    expect(screen.getByText("Last name is required")).toBeTruthy();
    expect(screen.getByText("Email is required")).toBeTruthy();
    expect(screen.getByText("Password is required")).toBeTruthy();
    expect(screen.getByText("Organization name is required")).toBeTruthy();
    expect(net.count("POST", "/auth/register")).toBe(0);

    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("validates the email format", async () => {
    const { net, user } = await open();

    await fill(user, { Email: "not-an-email" });
    await submit(user);

    expect(screen.getByText("Enter a valid email address")).toBeTruthy();
    expect(net.count("POST", "/auth/register")).toBe(0);
  });

  it("validates the password against the backend policy", async () => {
    const { net, user } = await open();

    await fill(user, { Password: "short" });
    await submit(user);

    expect(screen.getByText("Password must be at least 8 characters")).toBeTruthy();
    expect(net.count("POST", "/auth/register")).toBe(0);
  });

  it("submits the correct payload", async () => {
    const { net, user } = await open();

    await fill(user, { "First name": "  Ada  " });
    await submit(user);

    await screen.findByRole("heading", { name: "Check your email" });
    const call = net.last("POST", "/auth/register");
    expect(call?.body).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      password: PASSWORD,
      organizationName: "Analytical Engines",
    });
    expect(call?.init.credentials).toBe("include");
  });

  it("shows a loading state and blocks duplicate submission", async () => {
    let release: (response: Response) => void = () => {};
    const { net, user } = await open(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );

    await fill(user);
    await submit(user);

    const button = await screen.findByRole("button", { name: "Registering..." });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Registering..." }).closest("form")?.getAttribute("aria-busy")).toBe("true");

    await user.click(button);
    expect(net.count("POST", "/auth/register")).toBe(1);

    release(registerOk());
    await screen.findByRole("heading", { name: "Check your email" });
  });

  it("shows server validation errors next to the fields", async () => {
    const { user } = await open(() =>
      failure(400, "VALIDATION_ERROR", "Validation failed", {
        email: "Invalid email address",
      }),
    );

    await fill(user);
    await submit(user);

    expect((await screen.findAllByText("Invalid email address")).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toMatch(/check the highlighted fields/i);
  });

  it.each([
    [409, "An account with these details already exists"],
    [429, "Too many attempts"],
    [500, "The server ran into a problem"],
  ])("shows a friendly message for a %i response", async (status, text) => {
    const { user } = await open(() =>
      failure(status, "WHATEVER", "stack trace at /srv/app/secret.js"),
    );

    await fill(user);
    await submit(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(text);
    expect(alert.textContent).not.toContain("secret.js");
    expect(screen.queryByRole("heading", { name: "Check your email" })).toBeNull();
  });

  it("handles a network failure", async () => {
    const { user } = await open(() => {
      throw new TypeError("Failed to fetch");
    });

    await fill(user);
    await submit(user);

    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't reach the server/i);
  });

  it("shows the verification state, does not sign the user in, and hides the password", async () => {
    const log = vi.spyOn(console, "log");
    const { net, user } = await open();

    await fill(user);
    await submit(user);

    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/Please verify your email before signing in/);
    expect(status.textContent).toContain("ada@example.com");

    // Not authenticated: no login call, no app, no sign-out control.
    expect(net.count("POST", "/auth/login")).toBe(0);
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login");

    // The password is neither rendered nor logged.
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PASSWORD);
    expect(net.calls.every((c) => !c.path.includes(PASSWORD))).toBe(true);
    await waitFor(() => expect(window.localStorage.length).toBe(0));
  });

  it("toggles password visibility accessibly", async () => {
    const { user } = await open();
    const input = screen.getByLabelText("Password") as HTMLInputElement;

    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);

    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" }).getAttribute("aria-pressed")).toBe("true");
  });
});
