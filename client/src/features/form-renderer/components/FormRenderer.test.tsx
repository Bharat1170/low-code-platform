// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormSchema } from "../../form-builder/types/form-builder.types.ts";
import { FormRenderer } from "./FormRenderer.tsx";

afterEach(cleanup);

const field = (overrides: Record<string, unknown>) => ({
  description: "",
  required: false,
  validation: {},
  conditionalLogic: null,
  ...overrides,
});

const textField = (overrides: Record<string, unknown> = {}) =>
  field({
    id: "name",
    type: "TEXT",
    label: "Full name",
    config: { placeholder: "Ada Lovelace", defaultValue: "" },
    ...overrides,
  });

const emailField = (overrides: Record<string, unknown> = {}) =>
  field({
    id: "mail",
    type: "EMAIL",
    label: "Work email",
    config: { placeholder: "you@example.com", defaultValue: "" },
    ...overrides,
  });

const dropdownField = (overrides: Record<string, unknown> = {}) =>
  field({
    id: "country",
    type: "DROPDOWN",
    label: "Country",
    config: {
      placeholder: "Pick one",
      options: [
        { label: "India", value: "in" },
        { label: "France", value: "fr" },
      ],
      defaultValue: "",
    },
    ...overrides,
  });

const checkboxField = (overrides: Record<string, unknown> = {}) =>
  field({
    id: "agree",
    type: "CHECKBOX",
    label: "I agree",
    config: { defaultValue: false },
    ...overrides,
  });

const schemaOf = (...fields: unknown[]): FormSchema =>
  ({ version: 1, fields }) as FormSchema;

const mount = (schema: FormSchema, mode: "builder" | "preview" | "published" = "preview") => {
  render(<FormRenderer schema={schema} mode={mode} />);
  return userEvent.setup();
};

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Submit" }));

describe("rendering", () => {
  it("renders a TEXT field with label, description and placeholder", () => {
    mount(schemaOf(textField({ description: "As on your passport" })));

    const input = screen.getByLabelText("Full name") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("Ada Lovelace");
    expect(screen.getByText("As on your passport")).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("renders an EMAIL field", () => {
    mount(schemaOf(emailField()));
    expect((screen.getByLabelText("Work email") as HTMLInputElement).type).toBe("email");
  });

  it("renders DROPDOWN options and a placeholder entry", () => {
    mount(schemaOf(dropdownField()));

    const select = screen.getByLabelText("Country") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      "Pick one",
      "India",
      "France",
    ]);
  });

  it("renders a CHECKBOX with an associated label", () => {
    mount(schemaOf(checkboxField()));
    expect((screen.getByLabelText("I agree") as HTMLInputElement).type).toBe("checkbox");
  });

  it("applies default values", () => {
    mount(
      schemaOf(
        textField({ config: { placeholder: "", defaultValue: "Grace" } }),
        dropdownField({
          config: {
            placeholder: "",
            options: [{ label: "India", value: "in" }],
            defaultValue: "in",
          },
        }),
        checkboxField({ config: { defaultValue: true } }),
      ),
    );

    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Grace");
    expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe("in");
    expect((screen.getByLabelText("I agree") as HTMLInputElement).checked).toBe(true);
  });

  it("renders configuration as text, never as markup", () => {
    mount(schemaOf(textField({ label: "<img src=x onerror=alert(1)>", description: "<b>bold</b>" })));

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>bold</b>")).toBeTruthy();
  });

  it("marks required fields for assistive technology", () => {
    mount(schemaOf(textField({ required: true })));
    const input = screen.getByLabelText(/Full name/);
    expect(input.getAttribute("aria-required")).toBe("true");
  });
});

describe("validation", () => {
  it("shows an accessible required error on submit and focuses the first invalid field", async () => {
    const user = mount(schemaOf(textField({ required: true }), emailField()));

    await submit(user);

    const input = screen.getByLabelText(/Full name/);
    const error = screen.getByText("Full name is required");
    expect(error.getAttribute("role")).toBe("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("Please fix 1 field below.")).toBeTruthy();
  });

  it("validates email format", async () => {
    const user = mount(schemaOf(emailField()));
    await user.type(screen.getByLabelText("Work email"), "nope");
    await submit(user);
    expect(screen.getByText("Work email must be a valid email address")).toBeTruthy();
  });

  it("validates minLength and maxLength", async () => {
    const user = mount(schemaOf(textField({ validation: { minLength: 3, maxLength: 5 } })));
    const input = screen.getByLabelText("Full name");

    await user.type(input, "ab");
    await submit(user);
    expect(screen.getByText("Full name must be at least 3 characters")).toBeTruthy();

    await user.type(input, "cdef");
    expect(screen.getByText("Full name must be at most 5 characters")).toBeTruthy();
  });

  it("validates min/max and pattern", async () => {
    const user = mount(
      schemaOf(
        textField({ id: "age", label: "Age", validation: { min: 18, max: 65 } }),
        textField({ id: "code", label: "Code", validation: { pattern: "^[A-Z]{3}$" } }),
      ),
    );
    await user.type(screen.getByLabelText("Age"), "10");
    await user.type(screen.getByLabelText("Code"), "ab");
    await submit(user);

    expect(screen.getByText("Age must be at least 18")).toBeTruthy();
    expect(screen.getByText("Code is not in the expected format")).toBeTruthy();
  });

  it("requires a dropdown selection and a ticked required checkbox", async () => {
    const user = mount(schemaOf(dropdownField({ required: true }), checkboxField({ required: true })));
    await submit(user);

    expect(screen.getByText("Country is required")).toBeTruthy();
    expect(screen.getByText("I agree must be checked")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText(/Country/), "fr");
    await user.click(screen.getByLabelText(/I agree/));
    expect(screen.queryByText("Country is required")).toBeNull();
    expect(screen.queryByText("I agree must be checked")).toBeNull();
  });

  it("clears an error as soon as the value is corrected", async () => {
    const user = mount(schemaOf(textField({ required: true })));
    await submit(user);
    await user.type(screen.getByLabelText(/Full name/), "Ada");
    expect(screen.queryByText("Full name is required")).toBeNull();
  });

  it("shows a field's error after it is left, before any submit", async () => {
    const user = mount(schemaOf(textField({ required: true }), emailField()));
    await user.click(screen.getByLabelText(/Full name/));
    await user.tab();
    expect(screen.getByText("Full name is required")).toBeTruthy();
  });

  it("shows a local success state when everything is valid, and can start over", async () => {
    const user = mount(schemaOf(textField({ required: true })));
    await user.type(screen.getByLabelText(/Full name/), "Ada");

    await submit(user);

    expect(screen.getByRole("status").textContent).toContain("nothing was saved");
    await user.click(screen.getByRole("button", { name: "Start over" }));
    expect((screen.getByLabelText(/Full name/) as HTMLInputElement).value).toBe("");
  });
});

describe("modes", () => {
  it("never touches the network or storage and never mutates the schema", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const schema = schemaOf(textField({ required: true }), dropdownField(), checkboxField());
    const snapshot = structuredClone(schema);

    for (const mode of ["preview", "published", "builder"] as const) {
      const user = mount(schema, mode);
      if (mode !== "builder") {
        await user.type(screen.getByLabelText(/Full name/), "x");
        await user.selectOptions(screen.getByLabelText("Country"), "in");
        await user.click(screen.getByLabelText("I agree"));
        await submit(user);
      }
      cleanup();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(schema).toEqual(snapshot);
    vi.unstubAllGlobals();
  });

  it("builder mode is read-only and has no submit button", () => {
    mount(schemaOf(textField(), dropdownField(), checkboxField()), "builder");

    expect((screen.getByLabelText("Full name") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("Country") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("I agree") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("preview and published modes allow interaction", async () => {
    for (const mode of ["preview", "published"] as const) {
      const user = mount(schemaOf(textField()), mode);
      await user.type(screen.getByLabelText("Full name"), "Ada");
      expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Ada");
      cleanup();
    }
  });

  it("keeps entered values when the schema object is replaced (live preview)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FormRenderer schema={schemaOf(textField())} mode="preview" />);
    await user.type(screen.getByLabelText("Full name"), "Ada");

    rerender(<FormRenderer schema={schemaOf(textField(), emailField())} mode="preview" />);

    expect((screen.getByLabelText("Full name") as HTMLInputElement).value).toBe("Ada");
    expect(screen.getByLabelText("Work email")).toBeTruthy();
  });
});

describe("robustness", () => {
  it("handles an empty schema", () => {
    mount(schemaOf());
    expect(screen.getByText("This form has no fields yet.")).toBeTruthy();
  });

  it("handles a schema without a fields array", () => {
    mount({ version: 1 } as unknown as FormSchema);
    expect(screen.getByText("This form has no fields yet.")).toBeTruthy();
  });

  it("skips an unknown field type and still renders the rest", () => {
    mount(schemaOf({ id: "sig", type: "SIGNATURE", label: "Sign here" }, textField()));

    expect(screen.queryByText("Sign here")).toBeNull();
    expect(screen.getByLabelText("Full name")).toBeTruthy();
  });

  it("does not crash on invalid field configuration", () => {
    mount(
      schemaOf(
        textField({ config: null, validation: null }),
        dropdownField({ config: { options: "nope" } }),
        checkboxField({ config: undefined }),
      ),
    );

    expect(screen.getByLabelText("Full name")).toBeTruthy();
    expect((screen.getByLabelText("Country") as HTMLSelectElement).options).toHaveLength(1);
  });
});
