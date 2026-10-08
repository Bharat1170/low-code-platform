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
import {
  TEST_USER_POPUP_MESSAGE,
  TEST_USER_SAVE_FAILED_MESSAGE,
  TEST_USER_UNSAVED_MESSAGE,
  type PreviewWindow,
} from "./TestUserButton.tsx";

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
  const navigate = vi.fn<(url: string) => void>();
  const close = vi.fn<() => void>();
  const openPreviewWindow = vi.fn<() => PreviewWindow | null>(() => ({
    navigate,
    close,
  }));
  render(
    <FormBuilder
      formId={FORM_ID}
      initialSchema={schemaWithField()}
      saveDraft={saveDraft}
      publish={publish}
      openPreviewWindow={openPreviewWindow}
      {...props}
    />,
  );
  return {
    saveDraft,
    publish,
    openPreviewWindow,
    navigate,
    close,
    user: userEvent.setup(),
  };
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
  it("opens the draft preview BEFORE publishing, by form id only", async () => {
    const { openPreviewWindow, navigate, saveDraft, publish, user } = mount({
      initialStatus: "DRAFT",
    });

    await user.click(testUserButton());

    expect(openPreviewWindow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(`/forms/${FORM_ID}/preview`);
    // Nothing was published, and nothing needed saving.
    expect(publish).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("also works for a form that is already published", async () => {
    const { navigate, publish, user } = mount({
      initiallyPublished: true,
      initialStatus: "PUBLISHED",
    });

    await user.click(testUserButton());

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/forms/${FORM_ID}/preview`));
    expect(publish).not.toHaveBeenCalled();
  });

  it("opens the tab inside the click, before the save finishes", async () => {
    let resolve!: () => void;
    const saveDraft = vi.fn<SaveFn>(
      () => new Promise<void>((res) => (resolve = res)),
    );
    const { openPreviewWindow, navigate, user } = mount({ saveDraft });
    await addEmail(user);

    fireEvent.click(testUserButton());

    // Opened immediately (so pop-up blockers allow it) but not navigated yet.
    expect(openPreviewWindow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/forms/${FORM_ID}/preview`));
  });

  it("saves unsaved edits first so the preview shows the current draft", async () => {
    const { saveDraft, navigate, user } = mount();
    await addEmail(user);
    expect(saveDraft).not.toHaveBeenCalled();

    await user.click(testUserButton());

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(saveDraft.mock.calls[0][1].fields).toHaveLength(2);
  });

  it("creates the form on first use, then previews it", async () => {
    const createForm = vi.fn<() => Promise<string>>(() => Promise.resolve("new_form_id"));
    const { saveDraft, navigate, user } = mount({ formId: undefined, createForm });

    await user.click(testUserButton());

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/forms/new_form_id/preview"));
    expect(createForm).toHaveBeenCalledTimes(1);
    expect(saveDraft).toHaveBeenCalledWith("new_form_id", expect.anything());
  });

  it("closes the tab and explains when the draft could not be saved", async () => {
    const saveDraft = vi.fn<SaveFn>().mockRejectedValue(new Error("offline"));
    const { navigate, close, user } = mount({ saveDraft });
    await addEmail(user);

    await user.click(testUserButton());

    expect(await screen.findByText(TEST_USER_SAVE_FAILED_MESSAGE)).toBeTruthy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    // The edits are kept.
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(2);
  });

  it("explains a blocked pop-up and does not save", async () => {
    const { saveDraft, user } = mount({ openPreviewWindow: () => null });
    await addEmail(user);

    await user.click(testUserButton());

    expect(await screen.findByText(TEST_USER_POPUP_MESSAGE)).toBeTruthy();
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("explains that a builder with nowhere to save cannot be previewed", async () => {
    const { openPreviewWindow, user } = mount({ formId: undefined });

    await user.click(testUserButton());

    expect(screen.getByText(TEST_USER_UNSAVED_MESSAGE)).toBeTruthy();
    expect(openPreviewWindow).not.toHaveBeenCalled();
  });

  it("opens one tab for a rapid double click", async () => {
    const { openPreviewWindow, navigate } = mount();

    fireEvent.click(testUserButton());
    fireEvent.click(testUserButton());

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(openPreviewWindow).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the schema", async () => {
    const { saveDraft, user } = mount({ initiallyPublished: true });

    await user.click(testUserButton());
    await new Promise((r) => setTimeout(r, 900));

    expect(saveDraft).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(1);
  });
});
