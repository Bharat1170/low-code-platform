// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { PublishResult } from "../api/forms.api.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";

/*
 * Regression for the reported "Saved + Saved": the header has exactly ONE
 * save-status indicator in every state. The Draft/Published badge is a
 * different indicator and stays separate.
 */

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

afterEach(cleanup);

type SaveFn = (formId: string, schema: FormSchema) => Promise<void>;
type PublishFn = (formId: string) => Promise<PublishResult>;

const schemaWithField = (): FormSchema =>
  addField(createEmptyFormSchema(), createFieldDefinition("TEXT"));

const published: PublishResult = {
  formId: FORM_ID,
  versionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 1,
  status: "PUBLISHED",
  publishedAt: "2026-10-05T10:00:00.000Z",
};

const SAVE_TEXTS = ["Saved", "Saving…", "Unsaved changes", "Unable to save"];

/* Every element whose own text is one of the save-status labels. */
const saveIndicators = () =>
  SAVE_TEXTS.flatMap((text) => screen.queryAllByText(text));

const mount = (saveDraft: SaveFn = () => Promise.resolve(), publish?: PublishFn) =>
  render(
    <FormBuilder
      formId={FORM_ID}
      initialSchema={schemaWithField()}
      saveDraft={saveDraft}
      publish={publish ?? (() => Promise.resolve(published))}
    />,
  );

describe("exactly one save-status indicator", () => {
  it("renders a single indicator when saved", () => {
    const { container } = mount();

    expect(container.querySelectorAll(".fb-save-status")).toHaveLength(1);
    expect(saveIndicators()).toHaveLength(1);
    expect(screen.getAllByText("Saved")).toHaveLength(1);
  });

  it("renders a single indicator while there are unsaved changes", async () => {
    const { container } = mount(() => new Promise<void>(() => {}));

    await userEvent.setup().click(screen.getByRole("button", { name: "Add Email field" }));

    expect(container.querySelectorAll(".fb-save-status")).toHaveLength(1);
    expect(saveIndicators().map((el) => el.textContent)).toEqual(["Unsaved changes"]);
  });

  it("renders a single indicator while saving", async () => {
    const { container } = mount(() => new Promise<void>(() => {}));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Email field" }));

    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await waitFor(() => expect(saveIndicators()).toHaveLength(1));
    expect(container.querySelectorAll(".fb-save-status")).toHaveLength(1);
    expect(saveIndicators()[0].textContent).toBe("Saving…");
  });

  it("renders a single indicator after a failed save", async () => {
    const { container } = mount(() => Promise.reject(new Error("offline")));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Email field" }));
    await user.click(screen.getByRole("button", { name: "Save Draft" }));

    await waitFor(() => expect(screen.getByText("Unable to save")).toBeTruthy());
    expect(container.querySelectorAll(".fb-save-status")).toHaveLength(1);
    expect(saveIndicators()).toHaveLength(1);
  });

  it("keeps Published vN separate from the save indicator", async () => {
    const { container } = mount();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Publish" }));
    await user.click(
      screen.getByRole("dialog").querySelector<HTMLButtonElement>(".fb-button-primary")!,
    );

    await waitFor(() =>
      expect(container.querySelector(".fb-form-status")?.textContent).toBe("Publishedv1"),
    );
    // One "Published v1" badge AND one "Saved" indicator: two different things.
    expect(container.querySelectorAll(".fb-form-status")).toHaveLength(1);
    expect(container.querySelectorAll(".fb-save-status")).toHaveLength(1);
    expect(screen.getAllByText("Saved")).toHaveLength(1);
    expect(container.querySelector(".fb-form-status")?.textContent).not.toMatch(/sav/i);
  });

  it("shows no save indicator for a builder that cannot save", () => {
    const { container } = render(<FormBuilder />);

    expect(container.querySelectorAll(".fb-save-status")).toHaveLength(0);
    expect(saveIndicators()).toHaveLength(0);
  });
});
