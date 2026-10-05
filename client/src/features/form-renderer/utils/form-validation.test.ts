import { describe, expect, it } from "vitest";
import type { FormFieldDefinition } from "../../form-builder/types/form-builder.types.ts";
import {
  defaultValueFor,
  validateField,
  validateForm,
} from "./form-validation.ts";

const text = (
  validation: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): FormFieldDefinition =>
  ({
    id: "name",
    type: "TEXT",
    label: "Name",
    description: "",
    required: false,
    config: { placeholder: "", defaultValue: "" },
    validation,
    conditionalLogic: null,
    ...overrides,
  }) as FormFieldDefinition;

const email = (overrides: Record<string, unknown> = {}): FormFieldDefinition =>
  text({}, { id: "mail", type: "EMAIL", label: "Email", ...overrides });

const dropdown = (required = false): FormFieldDefinition =>
  ({
    id: "country",
    type: "DROPDOWN",
    label: "Country",
    description: "",
    required,
    config: {
      placeholder: "",
      options: [{ label: "India", value: "in" }],
      defaultValue: "",
    },
    validation: {},
    conditionalLogic: null,
  }) as FormFieldDefinition;

const checkbox = (required: boolean): FormFieldDefinition =>
  ({
    id: "agree",
    type: "CHECKBOX",
    label: "Terms",
    description: "",
    required,
    config: { defaultValue: false },
    validation: {},
    conditionalLogic: null,
  }) as FormFieldDefinition;

describe("validateField", () => {
  it("requires a value (field flag or validation rule), trimming blanks", () => {
    expect(validateField(text({}, { required: true }), "")).toBe("Name is required");
    expect(validateField(text({ required: true }), "   ")).toBe("Name is required");
    expect(validateField(text({}, { required: true }), "Ada")).toBeNull();
  });

  it("skips every other rule for an empty optional field", () => {
    expect(validateField(text({ minLength: 5, pattern: "^a$" }), "")).toBeNull();
  });

  it("checks minLength and maxLength", () => {
    expect(validateField(text({ minLength: 3 }), "ab")).toBe(
      "Name must be at least 3 characters",
    );
    expect(validateField(text({ maxLength: 4 }), "abcde")).toBe(
      "Name must be at most 4 characters",
    );
    expect(validateField(text({ minLength: 3, maxLength: 4 }), "abc")).toBeNull();
  });

  it("checks email format", () => {
    expect(validateField(email(), "nope")).toBe("Email must be a valid email address");
    expect(validateField(email(), "a b@c.com")).toBe("Email must be a valid email address");
    expect(validateField(email(), "ada@example.com")).toBeNull();
    expect(validateField(text({ email: true }), "x")).toBe(
      "Name must be a valid email address",
    );
  });

  it("checks min and max on numeric values", () => {
    const field = text({ min: 5, max: 10 });
    expect(validateField(field, "4")).toBe("Name must be at least 5");
    expect(validateField(field, "11")).toBe("Name must be at most 10");
    expect(validateField(field, "abc")).toBe("Name must be a number");
    expect(validateField(field, "7")).toBeNull();
  });

  it("checks a pattern, and ignores a pattern that does not compile", () => {
    expect(validateField(text({ pattern: "^[A-Z]+$" }), "abc")).toBe(
      "Name is not in the expected format",
    );
    expect(validateField(text({ pattern: "^[A-Z]+$" }), "ABC")).toBeNull();
    expect(validateField(text({ pattern: "([" }), "anything")).toBeNull();
  });

  it("requires a dropdown choice and rejects values that are not options", () => {
    expect(validateField(dropdown(true), "")).toBe("Country is required");
    expect(validateField(dropdown(), "")).toBeNull();
    expect(validateField(dropdown(), "zz")).toBe(
      "Country must be one of the available options",
    );
    expect(validateField(dropdown(true), "in")).toBeNull();
  });

  it("requires a checkbox to be checked only when required", () => {
    expect(validateField(checkbox(true), false)).toBe("Terms must be checked");
    expect(validateField(checkbox(true), true)).toBeNull();
    expect(validateField(checkbox(false), false)).toBeNull();
  });

  it("falls back to a generic name when the label is empty", () => {
    expect(validateField(text({}, { label: "  ", required: true }), "")).toBe(
      "This field is required",
    );
  });

  it("does not throw for malformed definitions", () => {
    const broken = { id: "x", type: "TEXT", label: 5, validation: null, config: null };
    expect(() => validateField(broken as never, "v")).not.toThrow();
    expect(defaultValueFor(broken as never)).toBe("");
  });
});

describe("validateForm", () => {
  it("returns messages keyed by stable field id, and nothing when valid", () => {
    const fields = [text({}, { required: true }), email()];

    expect(validateForm(fields, { name: "", mail: "bad" })).toEqual({
      name: "Name is required",
      mail: "Email must be a valid email address",
    });
    expect(validateForm(fields, { name: "Ada", mail: "" })).toEqual({});
  });

  it("skips unsupported fields", () => {
    const fields = [{ id: "z", type: "SIGNATURE", required: true }] as never[];
    expect(validateForm(fields, {})).toEqual({});
  });
});
