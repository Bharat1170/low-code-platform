// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS } from "../hooks/useDraftAutosave.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
  findFieldById,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";

/*
 * Field numbers are presentation only: derived from the current order of
 * schema.fields while rendering, never stored, saved or used as identity.
 */

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

type SaveFn = (formId: string, schema: FormSchema) => Promise<void>;

const schemaOf = (...ids: string[]): FormSchema => {
  let schema = createEmptyFormSchema();
  for (const id of ids) {
    const field = createFieldDefinition(
      id.startsWith("email") ? "EMAIL" : id.startsWith("check") ? "CHECKBOX" : "TEXT",
      id,
    );
    field.label = id;
    schema = addField(schema, field);
  }
  return schema;
};

const cards = () =>
  within(screen.getByRole("main", { name: "Form canvas" })).queryAllByRole("listitem");

/* The displayed numbers, in canvas order. */
const numbers = (): string[] =>
  cards().map((card) => card.querySelector(".fb-field-number")?.textContent ?? "");

const cardOf = (fieldId: string): HTMLElement => {
  const preview = document.getElementById(`${fieldId}-preview`);
  const card = preview?.closest("li");
  if (!card) throw new Error(`No card for ${fieldId}`);
  return card;
};

const renderBuilder = (schema: FormSchema, saveDraft?: SaveFn) =>
  render(<FormBuilder formId={FORM_ID} initialSchema={schema} saveDraft={saveDraft} />);

afterEach(cleanup);

describe("field numbering", () => {
  it("numbers fields 1, 2, 3 in canvas order", () => {
    renderBuilder(schemaOf("name", "email_1", "dept"));

    expect(numbers()).toEqual(["1", "2", "3"]);
    expect(cardOf("name").querySelector(".fb-field-number")?.textContent).toBe("1");
    expect(cardOf("email_1").querySelector(".fb-field-number")?.textContent).toBe("2");
    expect(cardOf("dept").querySelector(".fb-field-number")?.textContent).toBe("3");
  });

  it("renumbers after a field is removed", () => {
    renderBuilder(schemaOf("name", "email_1", "dept"));

    fireEvent.click(screen.getByRole("button", { name: "Remove email_1 field" }));

    expect(numbers()).toEqual(["1", "2"]);
    expect(cardOf("name").querySelector(".fb-field-number")?.textContent).toBe("1");
    expect(cardOf("dept").querySelector(".fb-field-number")?.textContent).toBe("2");
  });

  it("gives a newly added field the next number", () => {
    renderBuilder(schemaOf("name", "dept"));

    fireEvent.click(screen.getByRole("button", { name: "Add Checkbox field" }));

    expect(numbers()).toEqual(["1", "2", "3"]);
  });

  it("starts again at 1 after the first field is removed", () => {
    renderBuilder(schemaOf("name", "dept"));

    fireEvent.click(screen.getByRole("button", { name: "Remove name field" }));

    expect(numbers()).toEqual(["1"]);
    expect(cardOf("dept").querySelector(".fb-field-number")?.textContent).toBe("1");
  });

  it("shows no numbers in the empty state", () => {
    render(<FormBuilder />);

    expect(document.querySelector(".fb-field-number")).toBeNull();
  });

  it("does not change numbers when a field is selected or edited", () => {
    renderBuilder(schemaOf("name", "email_1", "dept"));

    fireEvent.click(screen.getByRole("button", { name: "Select email_1 field" }));
    expect(numbers()).toEqual(["1", "2", "3"]);

    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Work email" },
    });
    fireEvent.click(screen.getByLabelText("Required"));
    expect(numbers()).toEqual(["1", "2", "3"]);
    expect(cardOf("email_1").querySelector(".fb-field-number")?.textContent).toBe("2");
  });

  it("keeps the number outside the field label", () => {
    renderBuilder(schemaOf("name", "dept"));

    fireEvent.click(screen.getByRole("button", { name: "Select name field" }));

    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe("name");
    expect(screen.getByLabelText("name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove name field" })).toBeTruthy();
    // The number is a plain element: not interactive and not editable.
    const number = cardOf("name").querySelector(".fb-field-number");
    expect(number?.tagName).toBe("SPAN");
    expect(number?.closest("button")).toBeNull();
    expect(number?.querySelector("input, button")).toBeNull();
  });

  it("uses the stable field id (not the number) as React identity", () => {
    renderBuilder(schemaOf("name", "email_1", "dept"));
    const deptBefore = cardOf("dept");
    const nameBefore = cardOf("name");

    fireEvent.click(screen.getByRole("button", { name: "Remove email_1 field" }));

    // Same DOM nodes survive although "dept" moved from 3 to 2.
    expect(cardOf("dept")).toBe(deptBefore);
    expect(cardOf("name")).toBe(nameBefore);
    expect(cardOf("dept").querySelector(".fb-field-number")?.textContent).toBe("2");
  });

  it("keeps the stable field ids when numbers change", () => {
    renderBuilder(schemaOf("name", "email_1", "dept"));

    fireEvent.click(screen.getByRole("button", { name: "Remove name field" }));

    const ids = [...document.querySelectorAll("[id$='-preview']")].map((el) => el.id);
    expect(ids).toEqual(["email_1-preview", "dept-preview"]);
  });

  it("does not mutate the schema it was given", () => {
    const schema = schemaOf("name", "email_1");
    const snapshot = structuredClone(schema);

    renderBuilder(schema);
    fireEvent.click(screen.getByRole("button", { name: "Remove name field" }));

    expect(schema).toEqual(snapshot);
    expect(JSON.stringify(schema)).not.toMatch(/number/i);
  });
});

describe("field numbers are never persisted", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the autosave payload contains no field number and the same stable ids", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    renderBuilder(schemaOf("name", "email_1", "dept"), save);

    fireEvent.click(screen.getByRole("button", { name: "Remove email_1 field" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Checkbox field" }));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS));

    expect(save).toHaveBeenCalledTimes(1);
    const schema = save.mock.calls[0][1];

    expect(schema.fields.map((f) => f.id).slice(0, 2)).toEqual(["name", "dept"]);
    expect(schema.fields).toHaveLength(3);
    expect(findFieldById(schema, "dept")?.label).toBe("dept");

    const json = JSON.stringify(schema);
    expect(json).not.toMatch(/displayNumber|"number"|fieldNumber|"index"/);
    for (const field of schema.fields) {
      expect(Object.keys(field).sort()).toEqual([
        "conditionalLogic",
        "config",
        "description",
        "id",
        "label",
        "required",
        "type",
        "validation",
      ]);
    }
  });

  it("numbering changes alone do not trigger a save", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    renderBuilder(schemaOf("name", "dept"), save);

    fireEvent.click(screen.getByRole("button", { name: "Select dept field" }));
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3));

    expect(save).not.toHaveBeenCalled();
  });
});
