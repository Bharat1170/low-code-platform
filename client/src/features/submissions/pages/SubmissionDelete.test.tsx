// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
const listUrl = `/forms/${FORM_ID}/submissions`;

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const idOf = (n: number) => `665f1c2e8f1b2c3d4e5f6a${String(n).padStart(2, "0")}`;
const deletePath = (n: number) => `${listUrl}/${idOf(n)}`;

const item = (n: number) => ({
  id: idOf(n),
  formId: FORM_ID,
  formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 1,
  submittedBy: "665f1c2e8f1b2c3d4e5f6a01",
  submittedByName: "Ada Lovelace",
  submittedAt: "2026-10-05T10:00:00.000Z",
});

const details = (n: number) =>
  ok({
    submission: {
      ...item(n),
      formName: "Contact form",
      data: {},
      schema: null,
    },
  });

interface Backend {
  items: number[];
  /* Decides the DELETE answer; default removes the item and succeeds. */
  onDelete?: (n: number) => Response | Promise<Response>;
  pageOverrides?: Record<string, number>;
}

/* A tiny stateful backend: GET list reflects what DELETE has removed. */
const backend = (state: Backend): Handler => (method, path) => {
  if (method === "POST" && path === "/auth/refresh") return refreshOk();
  if (method === "GET" && path === "/auth/me") return meOk();
  if (method === "GET" && path === `/forms/${FORM_ID}`) {
    return ok({ form: { _id: FORM_ID, name: "Contact form", status: "PUBLISHED" } });
  }

  const target = state.items.find((n) => path === deletePath(n));
  if (method === "DELETE" && target !== undefined) {
    const answer = state.onDelete ? state.onDelete(target) : ok();
    return Promise.resolve(answer).then((response) => {
      if (response.ok) state.items = state.items.filter((n) => n !== target);
      return response;
    });
  }
  if (method === "DELETE") return failure(404, "SUBMISSION_NOT_FOUND");

  if (method === "GET" && path === deletePath(state.items[0] ?? -1)) {
    return details(state.items[0]);
  }
  if (method === "GET" && /\/submissions\/[a-f\d]{24}/.test(path)) {
    const n = state.items.find((candidate) => path.includes(idOf(candidate)));
    return n === undefined ? failure(404, "SUBMISSION_NOT_FOUND") : details(n);
  }

  if (method === "GET" && path.startsWith(listUrl)) {
    const total = state.pageOverrides?.total ?? state.items.length;
    return ok({
      items: state.items.map(item),
      pagination: {
        page: state.pageOverrides?.page ?? 1,
        pageSize: 25,
        total,
        totalPages: state.pageOverrides?.totalPages ?? Math.max(1, Math.ceil(total / 25)),
      },
    });
  }

  return failure(404, "NOT_FOUND");
};

const deleteButton = (n: number) =>
  screen.getByRole("button", { name: `Delete submission ${idOf(n).slice(-8)}` });

const dialog = () => screen.findByRole("dialog");

const confirmDelete = async () => {
  const box = await dialog();
  fireEvent.click(within(box).getByRole("button", { name: "Delete" }));
};

describe("deleting from the submissions list", () => {
  it("offers a Delete action per row and opens a confirmation that explains it is permanent", async () => {
    const state: Backend = { items: [1, 2] };
    installFetch(backend(state));
    renderApp(listUrl);
    await screen.findByRole("table");

    expect(deleteButton(1)).toBeTruthy();
    expect(deleteButton(2)).toBeTruthy();

    fireEvent.click(deleteButton(1));

    const box = await dialog();
    expect(within(box).getByText("Delete this submission?")).toBeTruthy();
    expect(box.textContent).toContain("permanently deleted");
    expect(box.textContent).toContain("cannot be undone");
  });

  it("does not call the API when the confirmation is cancelled", async () => {
    const net = installFetch(backend({ items: [1] }));
    renderApp(listUrl);
    await screen.findByRole("table");

    fireEvent.click(deleteButton(1));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes the right submission, shows progress, sends one request, then refreshes the list", async () => {
    let release: () => void = () => {};
    const state: Backend = {
      items: [1, 2],
      onDelete: () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(ok());
        }),
    };
    const net = installFetch(backend(state));
    renderApp(`${listUrl}?version=1`);
    await screen.findByRole("table");
    const listCallsBefore = net.calls.filter((c) => c.method === "GET" && c.path.startsWith(`${listUrl}?`)).length;

    fireEvent.click(deleteButton(2));
    const box = await dialog();
    const confirm = within(box).getByRole("button", { name: "Delete" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    const busy = (await within(box).findByRole("button", { name: "Deleting…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect((within(box).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    release();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Submission deleted.")).toBeTruthy();

    const deletes = net.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toBe(deletePath(2));

    await waitFor(() => {
      const table = screen.getByRole("table");
      expect(within(table).getAllByRole("row")).toHaveLength(2);
    });
    expect(screen.queryByRole("button", { name: `Delete submission ${idOf(2).slice(-8)}` })).toBeNull();

    const listCallsAfter = net.calls.filter((c) => c.method === "GET" && c.path.startsWith(`${listUrl}?`));
    expect(listCallsAfter.length).toBeGreaterThan(listCallsBefore);
    // Filters survive the refresh.
    expect(listCallsAfter[listCallsAfter.length - 1].path).toContain("version=1");
  });

  it("steps back a page when the deleted item was the only one on the current page", async () => {
    const state: Backend = { items: [1], pageOverrides: { page: 2, total: 26, totalPages: 2 } };
    const net = installFetch(backend(state));
    renderApp(`${listUrl}?page=2`);
    await screen.findByRole("table");

    fireEvent.click(deleteButton(1));
    await confirmDelete();

    await waitFor(() =>
      expect(
        net.calls.some((c) => c.method === "GET" && c.path.includes("page=1") && c.path.startsWith(`${listUrl}?`)),
      ).toBe(true),
    );
  });

  it("explains a 403 inside the dialog and keeps the submission", async () => {
    const state: Backend = { items: [1], onDelete: () => failure(403, "FORBIDDEN", "internal detail") };
    installFetch(backend(state));
    renderApp(listUrl);
    await screen.findByRole("table");

    fireEvent.click(deleteButton(1));
    await confirmDelete();

    const alert = await within(await dialog()).findByRole("alert");
    expect(alert.textContent).toContain("don't have permission to delete");
    expect(alert.textContent).not.toContain("internal detail");
    expect(state.items).toEqual([1]);
    // The dialog is usable again.
    expect((within(await dialog()).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("treats a 404 as already deleted: closes, says so, and refreshes", async () => {
    const state: Backend = { items: [1], onDelete: () => failure(404, "SUBMISSION_NOT_FOUND") };
    const net = installFetch(backend(state));
    renderApp(listUrl);
    await screen.findByRole("table");

    fireEvent.click(deleteButton(1));
    await confirmDelete();

    expect(await screen.findByText(/no longer exists/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(net.calls.filter((c) => c.method === "GET" && c.path.startsWith(`${listUrl}?`)).length).toBeGreaterThan(1);
  });

  it("shows a connection message on a network failure and a safe message on a 500", async () => {
    let attempt = 0;
    const state: Backend = {
      items: [1],
      onDelete: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : failure(500, "INTERNAL_SERVER_ERROR", "Mongo exploded: secret detail");
      },
    };
    installFetch(backend(state));
    renderApp(listUrl);
    await screen.findByRole("table");

    fireEvent.click(deleteButton(1));
    await confirmDelete();
    expect((await within(await dialog()).findByRole("alert")).textContent).toContain("Unable to reach the server");

    fireEvent.click(within(await dialog()).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      const text = screen.getByRole("alert").textContent ?? "";
      expect(text).toContain("Unable to delete the submission");
      expect(text).not.toContain("secret detail");
    });
    expect(state.items).toEqual([1]);
  });
});

describe("deleting from the details page", () => {
  it("confirms, deletes, returns to the list with the same filters, and refreshes it", async () => {
    const state: Backend = { items: [1, 2] };
    const net = installFetch(backend(state));
    renderApp(`${deletePath(1)}?version=1`);

    await screen.findByRole("heading", { name: `Submission ${idOf(1).slice(-8)}` });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await confirmDelete();

    expect(await screen.findByRole("table")).toBeTruthy();
    expect(await screen.findByText("Submission deleted.")).toBeTruthy();
    expect(net.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([deletePath(1)]);

    const lastList = [...net.calls].reverse().find((c) => c.method === "GET" && c.path.startsWith(`${listUrl}?`));
    expect(lastList?.path).toContain("version=1");
    await waitFor(() => expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2));
  });

  it("stays on the details page and shows the error when the delete is forbidden", async () => {
    const state: Backend = { items: [1], onDelete: () => failure(403, "FORBIDDEN") };
    installFetch(backend(state));
    renderApp(deletePath(1));

    await screen.findByRole("heading", { name: `Submission ${idOf(1).slice(-8)}` });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await confirmDelete();

    expect((await within(await dialog()).findByRole("alert")).textContent).toContain("don't have permission to delete");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("does not call the API when cancelled", async () => {
    const net = installFetch(backend({ items: [1] }));
    renderApp(deletePath(1));

    await screen.findByRole("heading", { name: `Submission ${idOf(1).slice(-8)}` });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
