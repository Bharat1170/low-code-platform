// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FORMS_PAGE_SIZE } from "../../form-builder/api/forms.api.ts";
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

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = (n: number, status: string) => ({
  _id: n.toString(16).padStart(24, "0"),
  name: `Form ${n}`,
  status,
  ...(status === "PUBLISHED" ? { publishedVersionId: "a".repeat(24) } : {}),
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z",
});

const withForms =
  (forms: unknown[]): Handler =>
  (method, path) => {
    if (method === "POST" && path === "/auth/refresh") return refreshOk();
    if (method === "GET" && path === "/auth/me") return meOk();
    if (method === "GET" && path.startsWith("/forms?")) return ok({ forms });
    return failure(404, "NOT_FOUND");
  };

const totals = async () => {
  const group = await screen.findByRole("group", { name: "Form totals" });
  return {
    published: within(group).getByText("published").parentElement!.textContent,
    total: within(group).getByText("total").parentElement!.textContent,
  };
};

describe("published form count", () => {
  it("shows how many forms are published, out of all forms", async () => {
    installFetch(
      withForms([
        form(1, "PUBLISHED"),
        form(2, "DRAFT"),
        form(3, "PUBLISHED"),
        form(4, "ARCHIVED"),
        form(5, "DRAFT"),
      ]),
    );
    renderApp("/forms");

    expect(await totals()).toEqual({ published: "2published", total: "5total" });
  });

  it("shows 0 when nothing has been published", async () => {
    installFetch(withForms([form(1, "DRAFT"), form(2, "DRAFT")]));
    renderApp("/forms");

    expect(await totals()).toEqual({ published: "0published", total: "2total" });
  });

  it("shows n+ when a full page was loaded, because there may be more", async () => {
    const forms = Array.from({ length: MAX_FORMS_PAGE_SIZE }, (_, i) =>
      form(i + 1, i % 2 === 0 ? "PUBLISHED" : "DRAFT"),
    );
    installFetch(withForms(forms));
    renderApp("/forms");

    expect(await totals()).toEqual({
      published: `${MAX_FORMS_PAGE_SIZE / 2}+published`,
      total: `${MAX_FORMS_PAGE_SIZE}+total`,
    });
  });

  it("shows no totals for an empty list", async () => {
    installFetch(withForms([]));
    renderApp("/forms");

    await screen.findByText("No forms yet");
    expect(screen.queryByRole("group", { name: "Form totals" })).toBeNull();
  });
});
