// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/forms.api.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "../utils/form-schema.utils.ts";
import { FormBuilderPage } from "./FormBuilderPage.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

const record = (draftSchema: unknown): api.FormRecord => ({
  id: FORM_ID,
  name: "F",
  status: "DRAFT",
  draftSchema,
});

let fetchForm: ReturnType<typeof vi.spyOn>;
let saveFormDraft: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchForm = vi.spyOn(api, "fetchForm");
  saveFormDraft = vi.spyOn(api, "saveFormDraft").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FormBuilderPage", () => {
  it("shows a loading state, then the persisted draft", async () => {
    const field = createFieldDefinition("TEXT", "name_field");
    field.label = "Saved label";
    fetchForm.mockResolvedValue(
      record(addField(createEmptyFormSchema(), field)),
    );

    render(<FormBuilderPage formId={FORM_ID} />);

    expect(screen.getByRole("status").textContent).toBe("Loading form…");
    expect(await screen.findByLabelText("Saved label")).toBeTruthy();
    expect(fetchForm).toHaveBeenCalledWith(FORM_ID);
  });

  it("starts empty when the form has no draft, and does not save it", async () => {
    fetchForm.mockResolvedValue(record(undefined));

    render(<FormBuilderPage formId={FORM_ID} />);

    expect(
      await screen.findByRole("heading", { name: "Build your form" }),
    ).toBeTruthy();
    expect(saveFormDraft).not.toHaveBeenCalled();
  });

  it("does not load an invalid draft, so it can never be overwritten", async () => {
    fetchForm.mockResolvedValue(record({ version: 1, fields: [{ type: "X" }] }));

    render(<FormBuilderPage formId={FORM_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/invalid/);
    expect(screen.queryByRole("main", { name: "Form canvas" })).toBeNull();
    expect(saveFormDraft).not.toHaveBeenCalled();
  });

  it.each([
    [401, /sign in/],
    [403, /permission/],
    [404, /not found/],
    [500, /Unable to load/],
  ])("shows a friendly message for a %i load failure", async (status, text) => {
    fetchForm.mockRejectedValue(new api.ApiError(status, "X", "internal detail"));

    render(<FormBuilderPage formId={FORM_ID} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(text);
    expect(alert.textContent).not.toMatch(/internal detail/);
  });

  it("shows a friendly message for a network failure", async () => {
    fetchForm.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<FormBuilderPage formId={FORM_ID} />);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Unable to load/),
    );
  });

  it("ignores a response that arrives after unmount", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolve: (value: api.FormRecord) => void = () => undefined;
    fetchForm.mockReturnValue(
      new Promise<api.FormRecord>((r) => {
        resolve = r;
      }),
    );

    const { unmount } = render(<FormBuilderPage formId={FORM_ID} />);
    unmount();
    resolve(record(undefined));
    await Promise.resolve();

    expect(errors).not.toHaveBeenCalled();
  });
});
