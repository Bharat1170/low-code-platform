// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
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
} from "../../auth/testing/test-utils.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const SUB_ID = "665f1c2e8f1b2c3d4e5f6aaa";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const schema = {
  version: 1,
  fields: [
    {
      id: "extras",
      type: "MULTI_SELECT",
      label: "Extras",
      description: "",
      required: false,
      validation: {},
      conditionalLogic: null,
      config: {
        options: [
          { label: "Cheese", value: "cheese" },
          { label: "Olives", value: "olives" },
        ],
        defaultValue: [],
      },
    },
    {
      id: "stars",
      type: "RATING",
      label: "Stars",
      description: "",
      required: false,
      validation: {},
      conditionalLogic: null,
      config: { max: 5, defaultValue: 0 },
    },
  ],
};

const handler: Handler = (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk();
  if (method === "GET" && path === "/auth/me") return meOk();
  if (method === "GET" && path === `/forms/${FORM_ID}`) {
    return ok({ form: { _id: FORM_ID, name: "Pizza", status: "PUBLISHED" } });
  }
  if (method === "GET" && path.startsWith(`/forms/${FORM_ID}/submissions?`)) {
    return ok({
      items: [
        {
          id: SUB_ID,
          formId: FORM_ID,
          formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
          version: 1,
          submittedBy: null,
          submittedByName: null,
          submittedAt: "2026-10-05T10:00:00.000Z",
        },
      ],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    });
  }
  if (method === "GET" && path === `/forms/${FORM_ID}/submissions/${SUB_ID}`) {
    return ok({
      submission: {
        id: SUB_ID,
        formId: FORM_ID,
        formName: "Pizza",
        formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
        version: 1,
        data: { extras: ["cheese", "olives"], stars: "4" },
        submittedBy: null,
        submittedByName: null,
        submittedAt: "2026-10-05T10:00:00.000Z",
        schema,
      },
    });
  }
  return failure(404, "NOT_FOUND");
};

describe("anonymous (public link) submissions", () => {
  it("are listed as Anonymous, with an Export CSV action", async () => {
    installFetch(handler);
    renderApp(`/forms/${FORM_ID}/submissions`);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("Anonymous")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeTruthy();
  });

  it("show multiple-choice and rating answers readably in details", async () => {
    installFetch(handler);
    renderApp(`/forms/${FORM_ID}/submissions/${SUB_ID}`);

    expect(await screen.findByText("Cheese (cheese), Olives (olives)")).toBeTruthy();
    expect(screen.getByText("4 / 5")).toBeTruthy();
    expect(screen.getByText("Anonymous")).toBeTruthy();
  });
});
