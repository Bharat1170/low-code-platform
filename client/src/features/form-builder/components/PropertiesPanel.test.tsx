// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FormFieldDefinition } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
  updateField,
  type FieldChanges,
} from "../utils/form-schema.utils.ts";
import { PropertiesPanel } from "./PropertiesPanel.tsx";

afterEach(cleanup);

/* Mirrors FormBuilder: state lives outside the panel, updates use updateField. */
let latest: FormFieldDefinition;
let calls: FieldChanges[];

function Harness({ initial }: { initial: FormFieldDefinition }) {
  const [schema, setSchema] = useState(() =>
    addField(createEmptyFormSchema(), initial),
  );
  const field = schema.fields[0];
  useEffect(() => {
    latest = field;
  });

  return (
    <PropertiesPanel
      field={field}
      onUpdateField={(id, changes) => {
        calls.push(changes);
        setSchema((current) => updateField(current, id, changes));
      }}
    />
  );
}

const setup = (field: FormFieldDefinition) => {
  calls = [];
  const snapshot = structuredClone(field);
  render(<Harness initial={field} />);
  return { user: userEvent.setup(), snapshot };
};

const textField = () => {
  const f = createFieldDefinition("TEXT", "text_1");
  f.label = "Name";
  f.config.placeholder = "Your name";
  f.config.defaultValue = "Ada";
  return f;
};

const emailField = () => createFieldDefinition("EMAIL", "email_1");
const dropdownField = () => {
  const f = createFieldDefinition("DROPDOWN", "dd_1");
  f.config.options = [
    { label: "India", value: "india" },
    { label: "USA", value: "usa" },
    { label: "UK", value: "uk" },
  ];
  return f;
};
const checkboxField = () => createFieldDefinition("CHECKBOX", "cb_1");

const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe("PropertiesPanel rendering", () => {
  it("shows an empty state when no field is selected", () => {
    render(<PropertiesPanel field={null} onUpdateField={() => {}} />);

    expect(screen.getByText("Select a field")).toBeTruthy();
    expect(
      screen.getByText("Choose a field on the canvas to configure its properties."),
    ).toBeTruthy();
  });

  it("renders text properties", () => {
    setup(textField());

    expect(screen.getByText("Text field")).toBeTruthy();
    for (const name of [
      "Label",
      "Description",
      "Required",
      "Placeholder",
      "Default value",
      "Minimum length",
      "Maximum length",
    ]) {
      expect(input(name)).toBeTruthy();
    }
    expect(input("Label").value).toBe("Name");
    expect(input("Placeholder").value).toBe("Your name");
  });

  it("renders email properties", () => {
    setup(emailField());

    for (const name of [
      "Label",
      "Description",
      "Required",
      "Placeholder",
      "Default value",
      "Minimum length",
      "Maximum length",
    ]) {
      expect(input(name)).toBeTruthy();
    }
  });

  it("renders dropdown properties without length controls", () => {
    setup(dropdownField());

    expect(input("Label")).toBeTruthy();
    expect(input("Required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ Add option" })).toBeTruthy();
    expect(screen.queryByLabelText("Minimum length")).toBeNull();
    expect(screen.queryByLabelText("Maximum length")).toBeNull();
    expect(screen.queryByLabelText("Placeholder")).toBeNull();
  });

  it("renders checkbox properties without length controls", () => {
    setup(checkboxField());

    expect(input("Default checked")).toBeTruthy();
    expect(input("Required")).toBeTruthy();
    expect(screen.queryByLabelText("Minimum length")).toBeNull();
    expect(screen.queryByLabelText("Maximum length")).toBeNull();
  });
});

describe("common properties", () => {
  it("updates label", () => {
    setup(textField());
    fireEvent.change(input("Label"), { target: { value: "Full name" } });
    expect(latest.label).toBe("Full name");
  });

  it("updates description", () => {
    setup(textField());
    fireEvent.change(input("Description"), { target: { value: "Shown to users" } });
    expect(latest.description).toBe("Shown to users");
  });

  it("updates required", async () => {
    const { user } = setup(textField());
    await user.click(input("Required"));
    expect(latest.required).toBe(true);
    await user.click(input("Required"));
    expect(latest.required).toBe(false);
  });
});

describe.each([
  ["TEXT", textField],
  ["EMAIL", emailField],
] as const)("%s properties", (_type, make) => {
  it("updates placeholder without losing default value", () => {
    setup(make());
    const before = (latest.config as { defaultValue: string }).defaultValue;
    fireEvent.change(input("Placeholder"), { target: { value: "hello" } });
    expect(latest.config).toMatchObject({ placeholder: "hello", defaultValue: before });
  });

  it("updates default value without losing placeholder", () => {
    setup(make());
    const before = (latest.config as { placeholder: string }).placeholder;
    fireEvent.change(input("Default value"), { target: { value: "abc" } });
    expect(latest.config).toMatchObject({ defaultValue: "abc", placeholder: before });
  });

  it("updates min and max length and preserves other validation", () => {
    setup(make());
    const other = { ...latest.validation };
    fireEvent.change(input("Maximum length"), { target: { value: "50" } });
    fireEvent.change(input("Minimum length"), { target: { value: "5" } });
    expect(latest.validation).toEqual({ ...other, minLength: 5, maxLength: 50 });
  });

  it("clears a limit when the input is emptied, keeping the other", () => {
    setup(make());
    fireEvent.change(input("Minimum length"), { target: { value: "3" } });
    fireEvent.change(input("Maximum length"), { target: { value: "9" } });
    fireEvent.change(input("Minimum length"), { target: { value: "" } });
    expect(latest.validation.minLength).toBeUndefined();
    expect(latest.validation.maxLength).toBe(9);
  });
});

describe("email validation preservation", () => {
  it("keeps the registry email rule when changing limits", () => {
    setup(emailField());
    expect(latest.validation.email).toBe(true);
    fireEvent.change(input("Minimum length"), { target: { value: "2" } });
    expect(latest.validation.email).toBe(true);
  });
});

describe("dropdown options", () => {
  it("renders existing options", () => {
    setup(dropdownField());
    expect(
      [1, 2, 3].map((n) => input(`Option ${n} label`).value),
    ).toEqual(["India", "USA", "UK"]);
    expect(input("Option 2 value").value).toBe("usa");
  });

  it("adds an option with a unique value", async () => {
    const { user } = setup(dropdownField());
    await user.click(screen.getByRole("button", { name: "+ Add option" }));
    const dd = latest as { config: { options: { label: string; value: string }[] } };
    expect(dd.config.options).toHaveLength(4);
    expect(dd.config.options[3]).toEqual({ label: "Option 4", value: "option-4" });
  });

  it("edits an option label and preserves the others", () => {
    setup(dropdownField());
    fireEvent.change(input("Option 2 label"), { target: { value: "United States" } });
    const options = (latest.config as { options: unknown[] }).options;
    expect(options).toEqual([
      { label: "India", value: "india" },
      { label: "United States", value: "usa" },
      { label: "UK", value: "uk" },
    ]);
  });

  it("edits an option value and preserves the others", () => {
    setup(dropdownField());
    fireEvent.change(input("Option 1 value"), { target: { value: "in" } });
    const options = (latest.config as { options: unknown[] }).options;
    expect(options).toEqual([
      { label: "India", value: "in" },
      { label: "USA", value: "usa" },
      { label: "UK", value: "uk" },
    ]);
  });

  it("removes an option", async () => {
    const { user } = setup(dropdownField());
    await user.click(screen.getByRole("button", { name: "Remove USA option" }));
    const options = (latest.config as { options: { label: string }[] }).options;
    expect(options.map((o) => o.label)).toEqual(["India", "UK"]);
  });

  it("resets the default value when its option is removed", async () => {
    const field = dropdownField();
    field.config.defaultValue = "usa";
    const { user } = setup(field);
    await user.click(screen.getByRole("button", { name: "Remove USA option" }));
    expect((latest.config as { defaultValue: string }).defaultValue).toBe("");
  });

  it("warns about duplicate option values", () => {
    setup(dropdownField());
    fireEvent.change(input("Option 2 value"), { target: { value: "india" } });
    expect(screen.getByText("Option values must be unique.")).toBeTruthy();
  });

  it("does not mutate the original options array", async () => {
    const field = dropdownField();
    const options = field.config.options;
    const optionsSnapshot = structuredClone(options);
    const { user } = setup(field);

    fireEvent.change(input("Option 1 label"), { target: { value: "Bharat" } });
    await user.click(screen.getByRole("button", { name: "+ Add option" }));
    await user.click(screen.getByRole("button", { name: "Remove UK option" }));

    expect(options).toEqual(optionsSnapshot);
    expect(latest.config).not.toBe(field.config);
  });
});

describe("checkbox properties", () => {
  it("updates default checked as a boolean", async () => {
    const { user } = setup(checkboxField());
    await user.click(input("Default checked"));
    expect((latest.config as { defaultValue: unknown }).defaultValue).toBe(true);
    await user.click(input("Default checked"));
    expect((latest.config as { defaultValue: unknown }).defaultValue).toBe(false);
  });

  it("updates required", async () => {
    const { user } = setup(checkboxField());
    await user.click(input("Required"));
    expect(latest.required).toBe(true);
  });
});

describe("length validation", () => {
  it("rejects a negative minimum", () => {
    setup(textField());
    fireEvent.change(input("Minimum length"), { target: { value: "-5" } });
    expect(screen.getByRole("alert").textContent).toMatch(/0 or more/);
    expect(latest.validation.minLength).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a negative maximum", () => {
    setup(textField());
    fireEvent.change(input("Maximum length"), { target: { value: "-1" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(latest.validation.maxLength).toBeUndefined();
  });

  it("rejects non-integer values", () => {
    setup(textField());
    fireEvent.change(input("Minimum length"), { target: { value: "1.5" } });
    expect(latest.validation.minLength).toBeUndefined();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("never allows minLength > maxLength", () => {
    setup(textField());
    fireEvent.change(input("Maximum length"), { target: { value: "10" } });
    fireEvent.change(input("Minimum length"), { target: { value: "20" } });

    expect(screen.getByRole("alert").textContent).toMatch(/cannot exceed/);
    expect(input("Minimum length").getAttribute("aria-invalid")).toBe("true");
    expect(latest.validation.minLength).toBeUndefined();
    expect(latest.validation.maxLength).toBe(10);
  });

  it("never allows maxLength < minLength", () => {
    setup(textField());
    fireEvent.change(input("Minimum length"), { target: { value: "20" } });
    fireEvent.change(input("Maximum length"), { target: { value: "10" } });

    expect(screen.getByRole("alert").textContent).toMatch(/less than/);
    expect(latest.validation.maxLength).toBeUndefined();
    expect(latest.validation.minLength).toBe(20);
  });

  it("clears the error once the value becomes valid", () => {
    setup(textField());
    fireEvent.change(input("Minimum length"), { target: { value: "-5" } });
    fireEvent.change(input("Minimum length"), { target: { value: "5" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(latest.validation.minLength).toBe(5);
  });

  it("uses input constraints", () => {
    setup(textField());
    expect(input("Minimum length").min).toBe("0");
    expect(input("Minimum length").type).toBe("number");
  });
});

describe("immutability and security", () => {
  it("does not mutate the original field", async () => {
    const field = textField();
    const { user, snapshot } = setup(field);

    fireEvent.change(input("Label"), { target: { value: "Changed" } });
    fireEvent.change(input("Placeholder"), { target: { value: "p" } });
    fireEvent.change(input("Maximum length"), { target: { value: "9" } });
    await user.click(input("Required"));

    expect(field).toEqual(snapshot);
    expect(latest).not.toBe(field);
    expect(latest.config).not.toBe(field.config);
    expect(latest.validation).not.toBe(field.validation);
  });

  it("renders HTML-like labels as text", () => {
    const field = textField();
    field.label = "<script>alert(1)</script>";
    const { container } = render(
      <PropertiesPanel field={field} onUpdateField={() => {}} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(input("Label").value).toBe("<script>alert(1)</script>");
  });

  it("only produces supported properties", async () => {
    const { user } = setup(dropdownField());
    const keysBefore = Object.keys(latest).sort();
    const configKeysBefore = Object.keys(latest.config).sort();

    fireEvent.change(input("Label"), { target: { value: "x" } });
    await user.click(screen.getByRole("button", { name: "+ Add option" }));
    fireEvent.change(input("Option 1 value"), { target: { value: "a" } });

    expect(Object.keys(latest).sort()).toEqual(keysBefore);
    expect(Object.keys(latest.config).sort()).toEqual(configKeysBefore);
    const options = (latest.config as { options: object[] }).options;
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(["label", "value"]);
    }
    expect(latest.id).toBe("dd_1");
    expect(latest.type).toBe("DROPDOWN");
  });
});

describe("accessibility", () => {
  it("gives every input an accessible name", () => {
    setup(textField());
    for (const control of screen.getAllByRole("textbox")) {
      expect(control.getAttribute("id")).toBeTruthy();
      expect(
        (control as HTMLInputElement).labels?.length ?? 0,
      ).toBeGreaterThan(0);
    }
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.getByRole("switch", { name: "Required" })).toBeTruthy();
  });

  it("names option removal buttons", () => {
    setup(dropdownField());
    const labels = screen
      .getAllByRole("button", { name: /^Remove/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Remove India option",
      "Remove USA option",
      "Remove UK option",
    ]);
  });

  it("is operable with the keyboard", async () => {
    const { user } = setup(dropdownField());

    await user.tab(); // Label
    expect(document.activeElement).toBe(input("Label"));
    await user.keyboard("{End}!");
    expect(latest.label).toBe("Dropdown!");

    const required = input("Required");
    required.focus();
    await user.keyboard(" ");
    expect(latest.required).toBe(true);

    const add = screen.getByRole("button", { name: "+ Add option" });
    add.focus();
    await user.keyboard("{Enter}");
    expect((latest.config as { options: unknown[] }).options).toHaveLength(4);

    const remove = within(document.body).getByRole("button", {
      name: "Remove Option 4 option",
    });
    remove.focus();
    await user.keyboard("{Enter}");
    expect((latest.config as { options: unknown[] }).options).toHaveLength(3);
  });
});
