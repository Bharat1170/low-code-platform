// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import {
  failure,
  installFetch,
  ok,
  ORGANIZATION,
  refreshOk,
  renderApp,
  USER,
} from "../../auth/testing/test-utils.tsx";
import { TEST_USER_SAVE_FAILED_MESSAGE } from "./TestUserButton.tsx";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* The signed-in account is literally named "Test User". */
const signedInAsTestUser = () =>
  installFetch((method, path) => {
    if (method === "POST" && path === "/auth/refresh") return refreshOk();
    if (method === "GET" && path === "/auth/me") {
      return ok({
        user: { ...USER, firstName: "Test", lastName: "User" },
        organization: ORGANIZATION,
      });
    }
    return failure(404, "NOT_FOUND");
  });

const once = (name: string) => screen.getAllByRole("button", { name });

describe("builder header controls", () => {
  it("renders exactly one Test User button, even when the account is named Test User", async () => {
    signedInAsTestUser();
    renderApp("/");
    await screen.findByRole("heading", { name: "Form Builder" });

    // One control...
    expect(once("Test User")).toHaveLength(1);

    // ...while the account name is plain text, not a second control.
    const matches = screen.getAllByText("Test User");
    expect(matches).toHaveLength(2);
    const nonButtons = matches.filter((el) => el.tagName !== "BUTTON");
    expect(nonButtons).toHaveLength(1);
    expect(nonButtons[0].classList.contains("auth-account-name")).toBe(true);
    expect(nonButtons[0].closest("button")).toBeNull();
  });

  it("renders Save Draft, Publish and Sign out once each", async () => {
    signedInAsTestUser();
    renderApp("/");
    await screen.findByRole("heading", { name: "Form Builder" });

    expect(once("Save Draft")).toHaveLength(1);
    expect(once("Publish")).toHaveLength(1);
    expect(once("Sign out")).toHaveLength(1);
  });

  it("keeps the Test User button working", async () => {
    signedInAsTestUser();
    renderApp("/");
    await screen.findByRole("heading", { name: "Form Builder" });

    // The real default opener: a blank tab that is closed again if the
    // draft cannot be saved (every form endpoint is a 404 here).
    const win = { close: vi.fn(), location: { href: "" }, opener: {} };
    const open = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);

    await userEvent.setup().click(once("Test User")[0]);

    expect((await screen.findByText(TEST_USER_SAVE_FAILED_MESSAGE)).textContent).toBe(
      TEST_USER_SAVE_FAILED_MESSAGE,
    );
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
    open.mockRestore();
  });
});
