// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormRenderer } from "../../form-renderer/components/FormRenderer.tsx";
import { validateField } from "../../form-renderer/utils/form-validation.ts";
import { FIELD_REGISTRY } from "../registry/field-registry.ts";
import type { DateFieldDefinition, FormSchema } from "../types/form-builder.types.ts";
import { isValidDateOnly } from "../utils/date-only.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
  updateField,
} from "../utils/form-schema.utils.ts";
import { validateFormSchema } from "../utils/form-schema.validate.ts";
import { FormBuilder } from "./FormBuilder.tsx";

afterEach(cleanup);

const dateField = (
  validation: DateFieldDefinition["validation"] = {},
  defaultValue = "",
): DateFieldDefinition => ({
  ...createFieldDefinition("DATE", "birthday"),
  label: "Birthday",
  validation,
  config: { defaultValue },
});

const schemaOf = (...fields: DateFieldDefinition[]): FormSchema => ({
  version: 1,
  fields,
});

describe("DATE field definition", () => {
  it("has the registry defaults: label, empty default, not required, no extra config", () => {
    const field = createFieldDefinition("DATE");

    expect(field.type).toBe("DATE");
    expect(field.label).toBe("Date field");
    expect(field.required).toBe(false);
    expect(field.config).toEqual({ defaultValue: "" });
    expect(field.validation).toEqual({});
    expect(field.conditionalLogic).toBeNull();
    expect(FIELD_REGISTRY.DATE.icon).toBe("date");
  });

  it("gets a stable, unique id", () => {
    const a = createFieldDefinition("DATE");
    const b = createFieldDefinition("DATE");

    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^field_[a-f0-9]{32}$/);
  });

  it("does not share objects with the registry", () => {
    const field = createFieldDefinition("DATE");
    field.config.defaultValue = "2026-01-01";

    expect(FIELD_REGISTRY.DATE.defaultConfig.defaultValue).toBe("");
  });

  it("stays JSON-safe (strings only, no Date objects)", () => {
    const schema = addField(createEmptyFormSchema(), createFieldDefinition("DATE"));
    const copy: unknown = JSON.parse(JSON.stringify(schema));

    expect(copy).toEqual(schema);
    expect(validateFormSchema(schema).valid).toBe(true);
  });
});

describe("isValidDateOnly", () => {
  it("accepts real dates and rejects rolled-over or malformed ones", () => {
    for (const ok of ["2026-01-31", "2024-02-29"]) expect(isValidDateOnly(ok)).toBe(true);
    for (const bad of ["2026-99-99", "2026-02-31", "2025-02-29", "2026-1-1", "", "2026-01-01T00:00", 20260101, null]) {
      expect(isValidDateOnly(bad)).toBe(false);
    }
  });
});

describe("DATE schema validation", () => {
  const errorsFor = (field: unknown) =>
    validateFormSchema({ version: 1, fields: [field] }).errors.join(" | ");

  it("accepts defaults, bounds and an in-range default", () => {
    for (const field of [
      dateField(),
      dateField({ minDate: "2020-01-01", maxDate: "2030-12-31" }),
      dateField({ minDate: "2020-01-01" }, "2026-06-15"),
    ]) {
      expect(validateFormSchema(schemaOf(field)).valid).toBe(true);
    }
  });

  it("rejects invalid dates, reversed bounds and out-of-range defaults", () => {
    expect(errorsFor(dateField({}, "2026-02-31"))).toMatch(/defaultValue/);
    expect(errorsFor(dateField({ minDate: "2026-99-99" }))).toMatch(/minDate/);
    expect(errorsFor(dateField({ maxDate: "nope" }))).toMatch(/maxDate/);
    expect(errorsFor(dateField({ minDate: "2026-12-31", maxDate: "2026-01-01" }))).toMatch(
      /must not exceed/,
    );
    expect(errorsFor(dateField({ minDate: "2026-06-01" }, "2026-01-01"))).toMatch(/within/);
  });

  it("rejects minDate/maxDate on other field types, and unknown types", () => {
    const text = { ...createFieldDefinition("TEXT"), validation: { minDate: "2026-01-01" } };
    expect(errorsFor(text)).toMatch(/only valid for DATE/);
    expect(errorsFor({ ...dateField(), type: "DATETIME" })).toMatch(/unknown field type/);
  });

  it("is unchanged for the other four types", () => {
    for (const type of ["TEXT", "EMAIL", "DROPDOWN", "CHECKBOX"] as const) {
      expect(validateFormSchema(schemaOf(createFieldDefinition(type) as never)).valid).toBe(true);
    }
  });

  it("updateField keeps the field a DATE and applies only known config keys", () => {
    const schema = schemaOf(dateField());

    const next = updateField(schema, "birthday", {
      config: { defaultValue: "2026-01-02", placeholder: "x" } as never,
    });

    expect(next.fields[0].config).toEqual({ defaultValue: "2026-01-02" });
    expect(next.fields[0].type).toBe("DATE");
  });
});

describe("Date in the builder", () => {
  const addDate = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: "Add Date field" }));

  it("appears in the palette, after the original four types", () => {
    render(<FormBuilder />);

    const palette = screen.getByRole("complementary", { name: "Field palette" });
    expect(within(palette).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Add Text field",
      "Add Email field",
      "Add Dropdown field",
      "Add Checkbox field",
      "Add Date field",
      "Add Long text field",
      "Add Number field",
      "Add Phone field",
      "Add Website field",
      "Add Single choice field",
      "Add Multiple choice field",
      "Add Rating field",
    ]);
    expect(within(palette).getByText("Date")).toBeTruthy();
    expect(palette.querySelectorAll("svg").length).toBe(12);
  });

  it("adds a numbered Date field to the canvas, selected, with a date preview", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);

    await addDate(user);

    const canvas = screen.getByRole("main", { name: "Form canvas" });
    const card = within(canvas).getByRole("listitem");
    expect(card.getAttribute("data-field-type")).toBe("DATE");
    expect(card.querySelector(".fb-field-number")?.textContent).toBe("1");
    const input = within(card).getByLabelText("Date field") as HTMLInputElement;
    expect(input.type).toBe("date");
    expect(input.readOnly).toBe(true);
    expect(screen.getByRole("complementary", { name: "Field properties" })).toBeTruthy();
  });

  it("two Date fields get different ids", async () => {
    const saveDraft = vi.fn<(id: string, s: FormSchema) => Promise<void>>(() => Promise.resolve());
    const user = userEvent.setup();
    render(<FormBuilder formId="665f1c2e8f1b2c3d4e5f6a7b" saveDraft={saveDraft} />);

    await addDate(user);
    await addDate(user);
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalled());
    const ids = saveDraft.mock.calls[0][1].fields.map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
    expect(saveDraft.mock.calls[0][1].fields.map((f) => f.type)).toEqual(["DATE", "DATE"]);
  });

  it("shows Date properties and saves a valid range", async () => {
    const saveDraft = vi.fn<(id: string, s: FormSchema) => Promise<void>>(() => Promise.resolve());
    const user = userEvent.setup();
    render(<FormBuilder formId="665f1c2e8f1b2c3d4e5f6a7b" saveDraft={saveDraft} />);
    await addDate(user);

    const props = screen.getByRole("complementary", { name: "Field properties" });
    expect(within(props).getByText("Date field")).toBeTruthy();
    for (const label of ["Label", "Description", "Required", "Default value", "Minimum date", "Maximum date"]) {
      expect(within(props).getByLabelText(label)).toBeTruthy();
    }
    expect((within(props).getByLabelText("Minimum date") as HTMLInputElement).type).toBe("date");
    expect(within(props).queryByLabelText("Placeholder")).toBeNull();
    expect(within(props).queryByLabelText("Minimum length")).toBeNull();

    fireEvent.change(within(props).getByLabelText("Minimum date"), { target: { value: "2026-01-01" } });
    fireEvent.change(within(props).getByLabelText("Maximum date"), { target: { value: "2026-12-31" } });
    fireEvent.change(within(props).getByLabelText("Default value"), { target: { value: "2026-06-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalled());
    const [field] = saveDraft.mock.calls[0][1].fields;
    expect(field.validation).toEqual({ minDate: "2026-01-01", maxDate: "2026-12-31" });
    expect(field.config).toEqual({ defaultValue: "2026-06-15" });
    expect(validateFormSchema(saveDraft.mock.calls[0][1]).valid).toBe(true);
  });

  it("does not commit a minimum after the maximum, and shows why", async () => {
    const user = userEvent.setup();
    render(<FormBuilder />);
    await addDate(user);
    const props = screen.getByRole("complementary", { name: "Field properties" });
    fireEvent.change(within(props).getByLabelText("Maximum date"), { target: { value: "2026-01-01" } });

    fireEvent.change(within(props).getByLabelText("Minimum date"), { target: { value: "2026-06-01" } });

    expect(within(props).getByRole("alert").textContent).toContain("on or before 2026-01-01");
    expect((within(props).getByLabelText("Minimum date") as HTMLInputElement).value).toBe("");
  });

  it("clearing a bound removes it from the schema", async () => {
    const saveDraft = vi.fn<(id: string, s: FormSchema) => Promise<void>>(() => Promise.resolve());
    const user = userEvent.setup();
    render(<FormBuilder formId="665f1c2e8f1b2c3d4e5f6a7b" saveDraft={saveDraft} />);
    await addDate(user);
    const props = screen.getByRole("complementary", { name: "Field properties" });
    fireEvent.change(within(props).getByLabelText("Minimum date"), { target: { value: "2026-01-01" } });
    fireEvent.change(within(props).getByLabelText("Minimum date"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Text field" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));

    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalled());
    expect(saveDraft.mock.calls[0][1].fields[0].validation).toEqual({});
  });
});

describe("Date in the renderer", () => {
  const mount = (field: DateFieldDefinition, mode: "preview" | "published" | "builder" = "preview") => {
    render(<FormRenderer schema={schemaOf(field)} mode={mode} />);
    return userEvent.setup();
  };

  it("renders a labelled date input with min/max and the default value", () => {
    mount({ ...dateField({ minDate: "2026-01-01", maxDate: "2026-12-31" }, "2026-06-15"), required: true });

    const input = screen.getByLabelText(/Birthday/) as HTMLInputElement;
    expect(input.type).toBe("date");
    expect(input.value).toBe("2026-06-15");
    expect(input.min).toBe("2026-01-01");
    expect(input.max).toBe("2026-12-31");
    expect(input.getAttribute("aria-required")).toBe("true");
  });

  it("requires a value and shows an accessible error", async () => {
    const user = mount({ ...dateField(), required: true });

    await user.click(screen.getByRole("button", { name: "Submit" }));

    const error = screen.getByText("Birthday is required");
    expect(error.getAttribute("role")).toBe("alert");
    expect(screen.getByLabelText(/Birthday/).getAttribute("aria-describedby")).toContain(error.id);
  });

  it("enforces the date range and then succeeds locally", async () => {
    mount(dateField({ minDate: "2026-01-10", maxDate: "2026-01-20" }));
    const input = screen.getByLabelText("Birthday");

    fireEvent.change(input, { target: { value: "2026-01-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText("Birthday must be on or after 2026-01-10")).toBeTruthy();

    fireEvent.change(input, { target: { value: "2026-01-25" } });
    expect(screen.getByText("Birthday must be on or before 2026-01-20")).toBeTruthy();

    fireEvent.change(input, { target: { value: "2026-01-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByRole("status").textContent).toContain("nothing was saved");
  });

  it("works the same in published mode, and is read-only in builder mode", () => {
    mount(dateField(), "published");
    expect((screen.getByLabelText("Birthday") as HTMLInputElement).readOnly).toBe(false);
    cleanup();

    mount(dateField(), "builder");
    expect((screen.getByLabelText("Birthday") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("validateField rejects invalid and rolled-over dates", () => {
    const field = dateField();

    expect(validateField(field, "2026-02-31")).toBe("Birthday must be a valid date");
    expect(validateField(field, "2026-99-99")).toBe("Birthday must be a valid date");
    expect(validateField(field, "")).toBeNull();
    expect(validateField(field, "2026-02-28")).toBeNull();
  });
});
