// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
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
import { ApiError, type PublishResult } from "../api/forms.api.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";

/*
 * Regression tests for "Save Draft and Publish are disabled": the builder
 * opened at "/" had no form to save to, so both buttons were permanently
 * disabled and nothing could ever be saved or published. A builder
 * without a form now creates one on first save, and Publish saves the
 * latest edits first.
 */

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

beforeEach(() => {
  clearAccessToken();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const result: PublishResult = {
  formId: FORM_ID,
  versionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 1,
  status: "PUBLISHED",
  publishedAt: "2026-10-05T10:00:00.000Z",
};

type SaveFn = (formId: string, schema: FormSchema) => Promise<void>;
type PublishFn = (formId: string) => Promise<PublishResult>;

const schemaWithField = (): FormSchema =>
  addField(createEmptyFormSchema(), createFieldDefinition("TEXT"));

const saveButton = () =>
  screen.getByRole("button", { name: /^Sav(e Draft|ing\.\.\.)$/ }) as HTMLButtonElement;
const publishTrigger = () =>
  screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
const confirm = () =>
  screen.getByRole("dialog").querySelector<HTMLButtonElement>(".fb-button-primary")!;
const badge = () => document.querySelector(".fb-form-status") as HTMLElement;

describe("a builder without a form (opened at /)", () => {
  const mount = (props: Partial<ComponentProps<typeof FormBuilder>> = {}) => {
    const createForm = vi.fn(() => Promise.resolve(FORM_ID));
    const onFormCreated = vi.fn();
    const saveDraft = vi.fn<SaveFn>(() => Promise.resolve());
    const publish = vi.fn<PublishFn>(() => Promise.resolve(result));
    render(
      <FormBuilder
        createForm={createForm}
        onFormCreated={onFormCreated}
        saveDraft={saveDraft}
        publish={publish}
        {...props}
      />,
    );
    return { createForm, onFormCreated, saveDraft, publish, user: userEvent.setup() };
  };

  it("enables Save Draft after an edit; saving creates the form once and saves the schema", async () => {
    const { createForm, onFormCreated, saveDraft, user } = mount();
    expect(saveButton().disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Add Text field" }));
    expect(saveButton().disabled).toBe(false);
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(createForm).toHaveBeenCalledTimes(1);
    expect(onFormCreated).toHaveBeenCalledWith(FORM_ID);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0][0]).toBe(FORM_ID);
    expect(saveDraft.mock.calls[0][1].fields).toHaveLength(1);
    // The builder was not reset: the field is still there.
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(1);

    // Later saves reuse the same form.
    await user.click(screen.getByRole("button", { name: "Add Email field" }));
    await user.click(saveButton());
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2));
    expect(createForm).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[1][0]).toBe(FORM_ID);
  });

  it("autosaves (and creates the form) after the debounce, without any click", async () => {
    const { createForm, saveDraft, user } = mount();

    await user.click(screen.getByRole("button", { name: "Add Text field" }));

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(createForm).toHaveBeenCalledTimes(1);
  });

  it("keeps edits and allows a retry when creating the form fails", async () => {
    const createForm = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL", "boom"))
      .mockResolvedValue(FORM_ID);
    const { saveDraft, user } = mount({ createForm });

    await user.click(screen.getByRole("button", { name: "Add Text field" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText("Unable to save")).toBeTruthy());
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(1);
    expect(saveDraft).not.toHaveBeenCalled();

    await user.click(saveButton());
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(saveDraft).toHaveBeenCalledTimes(1);
  });

  it("Publish is usable and saves (creating the form) before publishing", async () => {
    const order: string[] = [];
    const createForm = vi.fn(async () => {
      order.push("create");
      return FORM_ID;
    });
    const saveDraft = vi.fn<SaveFn>(async () => {
      order.push("save");
    });
    const publish = vi.fn<PublishFn>(async () => {
      order.push("publish");
      return result;
    });
    const { user } = mount({ createForm, saveDraft, publish });

    expect(publishTrigger().disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Add Text field" }));
    await user.click(publishTrigger());
    await user.click(confirm());

    await waitFor(() => expect(badge().textContent).toBe("Publishedv1"));
    expect(order).toEqual(["create", "save", "publish"]);
    expect(publish).toHaveBeenCalledWith(FORM_ID);
  });
});

describe("Publish with a persisted form", () => {
  const mount = (props: Partial<ComponentProps<typeof FormBuilder>> = {}) => {
    const saveDraft = vi.fn<SaveFn>(() => Promise.resolve());
    const publish = vi.fn<PublishFn>(() => Promise.resolve(result));
    render(
      <FormBuilder
        formId={FORM_ID}
        initialSchema={schemaWithField()}
        saveDraft={saveDraft}
        publish={publish}
        {...props}
      />,
    );
    return { saveDraft, publish, user: userEvent.setup() };
  };

  it("publishes the LATEST edits: saves first and waits for the save", async () => {
    let finishSave!: () => void;
    const saveDraft = vi.fn<SaveFn>(() => new Promise<void>((res) => (finishSave = res)));
    const { publish, user } = mount({ saveDraft });

    await user.click(screen.getByRole("button", { name: "Add Email field" }));
    await user.click(publishTrigger());
    await user.click(confirm());

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(publish).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Saving draft..." })).toBeTruthy();

    finishSave();

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(saveDraft.mock.calls[0][1].fields).toHaveLength(2);
  });

  it("does not publish when the save fails, keeps edits and never claims Published", async () => {
    const saveDraft = vi.fn<SaveFn>(() => Promise.reject(new Error("offline")));
    const { publish, user } = mount({ saveDraft });

    await user.click(screen.getByRole("button", { name: "Add Email field" }));
    await user.click(publishTrigger());
    await user.click(confirm());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nothing was published");
    expect(publish).not.toHaveBeenCalled();
    expect(badge().textContent).toBe("Draft");
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(2);
  });

  it("shows the server's publish error and stays Draft", async () => {
    const publish = vi
      .fn<PublishFn>()
      .mockRejectedValue(
        new ApiError(400, "FORM_SCHEMA_INVALID", "x", { "fields.0.label": "Field label is required" }),
      );
    const { user } = mount({ publish });

    await user.click(publishTrigger());
    await user.click(confirm());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Field 1: Field label is required");
    expect(badge().textContent).toBe("Draft");
  });

  it("does not offer a second publish of an unchanged draft", async () => {
    const { publish, user } = mount();

    await user.click(publishTrigger());
    await user.click(confirm());
    await waitFor(() => expect(badge().textContent).toBe("Publishedv1"));

    expect(publishTrigger().disabled).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("the whole app at / (real API layer)", () => {
  it("creates the form, saves with PATCH {draftSchema} and publishes with an empty POST", async () => {
    const handler: Handler = (method, path) => {
      if (method === "POST" && path === "/auth/refresh") return refreshOk();
      if (method === "GET" && path === "/auth/me") return meOk();
      if (method === "GET" && path === "/projects?limit=1") {
        return ok({ projects: [{ _id: "665f1c2e8f1b2c3d4e5f6c01" }] });
      }
      if (method === "POST" && path === "/forms") {
        return ok({ form: { _id: FORM_ID } });
      }
      if (method === "PATCH" && path === `/forms/${FORM_ID}`) {
        return ok({ form: { _id: FORM_ID } });
      }
      if (method === "POST" && path === `/forms/${FORM_ID}/publish`) {
        return ok({ ...result });
      }
      return failure(404, "NOT_FOUND");
    };
    const net = installFetch(handler);
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "Add Text field" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    const create = net.last("POST", "/forms");
    expect(create?.body).toMatchObject({
      status: "draft",
      projectId: "665f1c2e8f1b2c3d4e5f6c01",
    });
    expect(Object.keys(create?.body as object).sort()).toEqual(
      ["name", "projectId", "slug", "status"],
    );
    const patch = net.last("PATCH", `/forms/${FORM_ID}`);
    expect(Object.keys(patch?.body as object)).toEqual(["draftSchema"]);
    expect((patch?.body as { draftSchema: FormSchema }).draftSchema.fields).toHaveLength(1);
    // The address now carries the new form's id so a reload reopens it.
    expect(window.location.search).toContain(`formId=${FORM_ID}`);

    fireEvent.click(publishTrigger());
    fireEvent.click(confirm());

    await waitFor(() => expect(badge().textContent).toBe("Publishedv1"));
    const publishCall = net.last("POST", `/forms/${FORM_ID}/publish`);
    expect(publishCall?.body).toBeUndefined();
    expect(net.count("POST", "/forms")).toBe(1);
  });

  it("creates a default project when the account has none", async () => {
    const handler: Handler = (method, path) => {
      if (method === "POST" && path === "/auth/refresh") return refreshOk();
      if (method === "GET" && path === "/auth/me") return meOk();
      if (method === "GET" && path === "/projects?limit=1") return ok({ projects: [] });
      if (method === "POST" && path === "/projects") {
        return ok({ project: { _id: "665f1c2e8f1b2c3d4e5f6c02" } });
      }
      if (method === "POST" && path === "/forms") return ok({ form: { _id: FORM_ID } });
      if (method === "PATCH") return ok({ form: { _id: FORM_ID } });
      return failure(404, "NOT_FOUND");
    };
    const net = installFetch(handler);
    renderApp("/");

    fireEvent.click(await screen.findByRole("button", { name: "Add Text field" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(net.last("POST", "/forms")?.body).toMatchObject({
      projectId: "665f1c2e8f1b2c3d4e5f6c02",
    });
  });
});
