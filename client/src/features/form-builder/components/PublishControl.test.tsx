// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type PublishResult } from "../api/forms.api.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import { addField, createEmptyFormSchema, createFieldDefinition } from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";
import { PublishControl } from "./PublishControl.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

afterEach(cleanup);

const result = (version = 1): PublishResult => ({
  formId: FORM_ID,
  versionId: "665f1c2e8f1b2c3d4e5f6a99",
  version,
  status: "PUBLISHED",
  publishedAt: "2026-10-05T10:00:00.000Z",
});

type PublishFn = (formId: string) => Promise<PublishResult>;

const deferred = () => {
  let resolve!: (value: PublishResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<PublishResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mount = (
  publish: PublishFn,
  props: { draftSaved?: boolean; formId?: string; initiallyPublished?: boolean } = {},
) => {
  render(
    <PublishControl
      formId={"formId" in props ? props.formId : FORM_ID}
      draftSaved={props.draftSaved ?? true}
      initiallyPublished={props.initiallyPublished ?? false}
      publish={publish}
    />,
  );
  return userEvent.setup();
};

const trigger = () => screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
const dialog = () => screen.queryByRole("dialog");
const confirmButton = () =>
  screen.getByRole("dialog").querySelector<HTMLButtonElement>(".fb-button-primary")!;

describe("PublishControl", () => {
  it("renders an enabled Publish button for a saved form", () => {
    mount(vi.fn<PublishFn>());
    expect(trigger().disabled).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("is disabled when there is nothing saved to publish", () => {
    mount(vi.fn<PublishFn>(), { draftSaved: false });
    expect(trigger().disabled).toBe(true);
    expect(trigger().title).toBe("Save your latest changes before publishing.");
  });

  it("is disabled for a form that is not persisted", () => {
    mount(vi.fn<PublishFn>(), { formId: undefined });
    expect(trigger().disabled).toBe(true);
  });

  it("asks for confirmation first and does not publish on open or Cancel", async () => {
    const publish = vi.fn<PublishFn>();
    const user = mount(publish);

    await user.click(trigger());

    const box = screen.getByRole("dialog");
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading", { name: "Publish this form?" })).toBeTruthy();
    expect(box.textContent).toMatch(/immutable version/i);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(dialog()).toBeNull();
    expect(publish).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape and keeps keyboard focus inside the dialog", async () => {
    const user = mount(vi.fn<PublishFn>());
    await user.click(trigger());

    await user.tab();
    expect(document.activeElement).toBe(confirmButton());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirmButton());

    await user.keyboard("{Escape}");
    expect(dialog()).toBeNull();
  });

  it("publishes the form on confirm and shows the version", async () => {
    const publish = vi.fn<PublishFn>().mockResolvedValue(result(3));
    const user = mount(publish);

    await user.click(trigger());
    await user.click(confirmButton());

    await waitFor(() => expect(dialog()).toBeNull());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(FORM_ID);
    expect(screen.getByRole("status").textContent).toContain("Published · Version 3");
  });

  it("shows a loading state and blocks duplicate clicks while publishing", async () => {
    const pending = deferred();
    const publish = vi.fn<PublishFn>(() => pending.promise);
    const user = mount(publish);

    await user.click(trigger());
    const confirm = confirmButton();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toBe("Publishing...");
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(trigger().disabled).toBe(true);

    // Escape cannot dismiss the dialog mid-request.
    await user.keyboard("{Escape}");
    expect(dialog()).not.toBeNull();

    pending.resolve(result(1));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not claim success until the API confirms", async () => {
    const pending = deferred();
    const user = mount(() => pending.promise);

    await user.click(trigger());
    await user.click(confirmButton());

    expect(screen.queryByRole("status")).toBeNull();
    pending.resolve(result(1));
    await screen.findByText("Published · Version 1");
  });

  it("lists the server's validation problems and stays open for another try", async () => {
    const publish = vi
      .fn<PublishFn>()
      .mockRejectedValueOnce(
        new ApiError(400, "FORM_SCHEMA_INVALID", "invalid", {
          "fields.1.label": "Field label is required",
          "fields.0.config.options": "A dropdown needs at least one option",
        }),
      )
      .mockResolvedValueOnce(result(1));
    const user = mount(publish);

    await user.click(trigger());
    await user.click(confirmButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/can't be published yet/i);
    expect(alert.textContent).toContain("Field 2: Field label is required");
    expect(alert.textContent).toContain("Field 1: A dropdown needs at least one option");
    expect(dialog()).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(confirmButton().disabled).toBe(false);

    await user.click(confirmButton());
    await screen.findByText("Published · Version 1");
  });

  it.each([
    [new ApiError(409, "FORM_NO_CHANGES", "x"), /no changes since the last published version/i],
    [new ApiError(409, "PUBLISH_CONFLICT", "x"), /published by someone else/i],
    [new ApiError(403, "FORBIDDEN", "x"), /permission to publish/i],
    [new ApiError(401, "UNAUTHORIZED", "x"), /session has expired/i],
    [new ApiError(404, "FORM_NOT_FOUND", "x"), /no longer exists/i],
    [new ApiError(429, "RATE_LIMITED", "x"), /too many requests/i],
    [new ApiError(0, "NETWORK_ERROR", "x"), /couldn't reach the server/i],
    [new ApiError(500, "INTERNAL_ERROR", "stack trace /srv/secret.js"), /publishing failed/i],
    [new Error("boom"), /publishing failed/i],
  ])("shows a friendly message for %#", async (error, pattern) => {
    const user = mount(vi.fn<PublishFn>().mockRejectedValue(error));

    await user.click(trigger());
    await user.click(confirmButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(pattern);
    expect(alert.textContent).not.toContain("secret.js");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows Published for a form that was already published when opened", () => {
    mount(vi.fn<PublishFn>(), { initiallyPublished: true });
    expect(screen.getByRole("status").textContent).toBe("Published");
  });
});

describe("Publish inside the builder", () => {
  const schemaWithField = (): FormSchema => {
    const field = createFieldDefinition("TEXT", "name_field");
    field.label = "Name";
    return addField(createEmptyFormSchema(), field);
  };

  const saveOk = vi.fn(() => Promise.resolve());

  it("stays usable with unsaved edits: publishing saves them first", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
    });
    const publish = vi.fn<PublishFn>(async () => {
      order.push("publish");
      return result(1);
    });
    render(
      <FormBuilder
        formId={FORM_ID}
        initialSchema={schemaWithField()}
        saveDraft={save}
        publish={publish}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add Email field" }));
    expect(trigger().disabled).toBe(false);

    await user.click(trigger());
    await user.click(confirmButton());

    await screen.findByText("v1");
    expect(order).toEqual(["save", "publish"]);
  });

  it("keeps the draft exactly as it was when publishing fails", async () => {
    const user = userEvent.setup();
    const publish = vi
      .fn<PublishFn>()
      .mockRejectedValue(new ApiError(500, "INTERNAL_ERROR", "boom"));
    const save = vi.fn(() => Promise.resolve());
    render(
      <FormBuilder
        formId={FORM_ID}
        initialSchema={schemaWithField()}
        saveDraft={save}
        publish={publish}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add Email field" }));
    await user.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() => expect(trigger().disabled).toBe(false));
    const savesBefore = save.mock.calls.length;

    await user.click(trigger());
    await user.click(confirmButton());
    await screen.findByRole("alert");

    // Same two fields, still saved: publishing changed nothing and saved nothing.
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(2);
    expect(save.mock.calls.length).toBe(savesBefore);
    expect(screen.getByText("Saved")).toBeTruthy();

    // The dialog can be dismissed and editing carries on.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Add Checkbox field" }));
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(3);
  });

  it("shows the published version and stays editable after a successful publish", async () => {
    const user = userEvent.setup();
    const publish = vi.fn<PublishFn>().mockResolvedValue(result(2));
    render(
      <FormBuilder
        formId={FORM_ID}
        initialSchema={schemaWithField()}
        saveDraft={saveOk}
        publish={publish}
      />,
    );

    await user.click(trigger());
    await user.click(confirmButton());

    await screen.findByText("v2");
    expect(screen.getByText("Published")).toBeTruthy();
    expect(publish).toHaveBeenCalledWith(FORM_ID);

    await user.click(screen.getByRole("button", { name: "Add Dropdown field" }));
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(2);
  });

  it("does not offer publishing for an unsaved (local-only) builder", () => {
    render(<FormBuilder publish={vi.fn<PublishFn>()} />);
    expect(trigger().disabled).toBe(true);
  });
});
