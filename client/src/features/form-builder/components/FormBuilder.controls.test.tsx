// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishResult } from "../api/forms.api.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

afterEach(cleanup);

const schemaWithField = (): FormSchema =>
  addField(createEmptyFormSchema(), createFieldDefinition("TEXT"));

const publishResult: PublishResult = {
  formId: FORM_ID,
  versionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 4,
  status: "PUBLISHED",
  publishedAt: "2026-10-05T10:00:00.000Z",
};

type SaveFn = (formId: string, schema: FormSchema) => Promise<void>;
type PublishFn = (formId: string) => Promise<PublishResult>;

const mount = (props: Partial<ComponentProps<typeof FormBuilder>> = {}) => {
  const saveDraft = vi.fn<SaveFn>(() => Promise.resolve());
  const publish = vi.fn<PublishFn>(() => Promise.resolve(publishResult));
  const openTestTab = vi.fn<(url: string) => void>();
  render(
    <FormBuilder
      formId={FORM_ID}
      initialSchema={schemaWithField()}
      saveDraft={saveDraft}
      publish={publish}
      openTestTab={openTestTab}
      {...props}
    />,
  );
  return { saveDraft, publish, openTestTab, user: userEvent.setup() };
};

const saveButton = () =>
  screen.getByRole("button", { name: /^Sav(e Draft|ing\.\.\.)$/ });
const publishButton = () =>
  screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
const testUserButton = () => screen.getByRole("button", { name: "Test User" });
const badge = () => document.querySelector(".fb-form-status") as HTMLElement;
const addEmail = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Add Email field" }));

describe("status badge", () => {
  it("shows Draft for a DRAFT form", () => {
    mount({ initialStatus: "DRAFT" });
    expect(badge().textContent).toBe("Draft");
    expect(badge().getAttribute("data-status")).toBe("DRAFT");
  });

  it("shows Published for a PUBLISHED form", () => {
    mount({ initialStatus: "PUBLISHED", initiallyPublished: true });
    expect(badge().textContent).toBe("Published");
  });

  it("shows Archived and disables Publish for an ARCHIVED form", () => {
    mount({ initialStatus: "ARCHIVED" });
    expect(badge().textContent).toBe("Archived");
    expect(publishButton().disabled).toBe(true);
  });

  it("is not a control", () => {
    mount();
    expect(badge().closest("button")).toBeNull();
    expect(badge().getAttribute("tabindex")).toBeNull();
  });
});

describe("Save Draft", () => {
  it("is disabled and sends nothing when there are no changes", () => {
    const { saveDraft } = mount();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("saves the changed schema once, and shows Saved", async () => {
    const { saveDraft, user } = mount();
    await addEmail(user);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);

    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [id, saved] = saveDraft.mock.calls[0];
    expect(id).toBe(FORM_ID);
    expect(saved.fields).toHaveLength(2);
    expect(Object.keys(saved).sort()).toEqual(["fields", "version"]);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Saving... and ignores a second click while the request runs", async () => {
    let resolve!: () => void;
    const saveDraft = vi.fn<SaveFn>(
      () => new Promise<void>((res) => (resolve = res)),
    );
    const { user } = mount({ saveDraft });
    await addEmail(user);

    fireEvent.click(saveButton());
    fireEvent.click(saveButton());

    expect(screen.getByRole("button", { name: "Saving..." })).toBeTruthy();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  it("keeps local changes on failure, shows Unable to save and can retry", async () => {
    const saveDraft = vi
      .fn<SaveFn>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { user } = mount({ saveDraft });
    await addEmail(user);

    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("Unable to save")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(2);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);

    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(saveDraft).toHaveBeenCalledTimes(2);
    expect(saveDraft.mock.calls[1][1].fields).toHaveLength(2);
  });
});

describe("Publish", () => {
  it("is usable with unsaved edits, and disabled only while a save is running", async () => {
    const saveDraft = vi.fn<SaveFn>(() => new Promise<void>(() => {}));
    const { user } = mount({ saveDraft });

    await addEmail(user);
    expect(publishButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    expect(publishButton().disabled).toBe(true);
  });

  it("calls the publish endpoint with only the form id and shows Published", async () => {
    const { publish, user } = mount();

    await user.click(publishButton());
    await user.click(
      screen
        .getByRole("dialog")
        .querySelector<HTMLButtonElement>(".fb-button-primary")!,
    );

    await waitFor(() => expect(badge().textContent).toBe("Publishedv4"));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]).toEqual([FORM_ID]);
    // Nothing new to publish until the draft changes.
    expect(publishButton().disabled).toBe(true);

    await addEmail(user);
    await user.click(saveButton());
    await waitFor(() => expect(publishButton().disabled).toBe(false));
  });
});

describe("Test User", () => {
  it("opens the preview of a published form in a new tab, by id only", async () => {
    const { openTestTab, saveDraft, publish, user } = mount({
      initiallyPublished: true,
      initialStatus: "PUBLISHED",
    });

    await user.click(testUserButton());

    expect(openTestTab).toHaveBeenCalledTimes(1);
    expect(openTestTab).toHaveBeenCalledWith(`/forms/${FORM_ID}/preview`);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not open an unpublished draft and explains why", async () => {
    const { openTestTab, saveDraft, publish, user } = mount();

    await user.click(testUserButton());

    expect(openTestTab).not.toHaveBeenCalled();
    expect(
      screen.getByText("Publish the form before testing it as a user."),
    ).toBeTruthy();
    expect(saveDraft).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not mutate the schema", async () => {
    const { saveDraft, user } = mount({ initiallyPublished: true });

    await user.click(testUserButton());
    await new Promise((r) => setTimeout(r, 900));

    expect(saveDraft).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(1);
  });
});
