import { describe, expect, it } from "vitest";

import { FIELD_TYPES } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
} from "./form-schema.utils.ts";
import { isFormSchema, validateFormSchema } from "./form-schema.validate.ts";

/* A schema as it would arrive from the API: parsed JSON. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const schemaOf = (...types: (typeof FIELD_TYPES)[number][]) => {
  let schema = createEmptyFormSchema();
  types.forEach((type, index) => {
    schema = addField(schema, createFieldDefinition(type, `field${index}`));
  });
  return schema;
};

const withField = (
  override: Record<string, unknown>,
  type: (typeof FIELD_TYPES)[number] = "TEXT",
): unknown => {
  const schema = asJson(schemaOf(type)) as {
    fields: Record<string, unknown>[];
  };
  schema.fields[0] = { ...schema.fields[0], ...override };
  return schema;
};

const errorsOf = (value: unknown): string[] =>
  validateFormSchema(value).errors;

describe("validateFormSchema: valid schemas", () => {
  it("accepts an empty form", () => {
    expect(validateFormSchema(createEmptyFormSchema())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each(FIELD_TYPES)("accepts a valid %s field", (type) => {
    const schema = asJson(schemaOf(type));

    expect(validateFormSchema(schema)).toEqual({ valid: true, errors: [] });
    expect(isFormSchema(schema)).toBe(true);
  });

  it("accepts all four field types together", () => {
    expect(isFormSchema(asJson(schemaOf(...FIELD_TYPES)))).toBe(true);
  });

  it("accepts a dropdown with a default matching an option", () => {
    const schema = withField(
      {
        config: {
          placeholder: "p",
          options: [{ label: "A", value: "a" }],
          defaultValue: "a",
        },
      },
      "DROPDOWN",
    );

    expect(isFormSchema(schema)).toBe(true);
  });

  it("accepts every supported validation rule", () => {
    const schema = withField({
      validation: {
        required: true,
        minLength: 1,
        maxLength: 5,
        min: -1,
        max: 1,
        pattern: "^[a-z]+$",
        email: false,
      },
    });

    expect(validateFormSchema(schema)).toEqual({ valid: true, errors: [] });
  });
});

describe("validateFormSchema: field ids", () => {
  it("detects duplicate field ids", () => {
    const schema = asJson(schemaOf("TEXT", "EMAIL")) as {
      fields: { id: string }[];
    };
    schema.fields[1].id = schema.fields[0].id;

    expect(isFormSchema(schema)).toBe(false);
    expect(errorsOf(schema).join()).toMatch(/duplicate id/);
  });

  it.each(["", "1abc", "has space", "a;b", "$where", "x".repeat(65), 5, null])(
    "rejects invalid id %j",
    (id) => {
      expect(isFormSchema(withField({ id }))).toBe(false);
    },
  );
});

describe("validateFormSchema: field types", () => {
  it.each(["NUMBER", "text", "", "constructor", "__proto__", 5, null])(
    "rejects unknown field type %j",
    (type) => {
      const schema = withField({ type });

      expect(isFormSchema(schema)).toBe(false);
    },
  );

  it("rejects a config that belongs to another field type", () => {
    const schema = withField({
      config: { placeholder: "", defaultValue: "", options: [] },
    });

    expect(isFormSchema(schema)).toBe(false);
  });

  it("rejects a checkbox with a string default", () => {
    expect(
      isFormSchema(withField({ config: { defaultValue: "yes" } }, "CHECKBOX")),
    ).toBe(false);
  });
});

describe("validateFormSchema: dropdown options", () => {
  const dropdown = (config: Record<string, unknown>): unknown =>
    withField({ config }, "DROPDOWN");

  it.each([
    ["a missing value", [{ label: "A" }]],
    ["an empty label", [{ label: "", value: "a" }]],
    ["an extra key", [{ label: "A", value: "a", onClick: "x" }]],
    ["a non-string value", [{ label: "A", value: 1 }]],
    ["a non-object option", ["a"]],
    [
      "duplicate values",
      [
        { label: "A", value: "a" },
        { label: "B", value: "a" },
      ],
    ],
  ])("rejects options with %s", (_label, options) => {
    expect(
      isFormSchema(dropdown({ placeholder: "", options, defaultValue: "" })),
    ).toBe(false);
  });

  it("rejects a default that is not an option value", () => {
    expect(
      isFormSchema(
        dropdown({
          placeholder: "",
          options: [{ label: "A", value: "a" }],
          defaultValue: "zzz",
        }),
      ),
    ).toBe(false);
  });

  it("rejects non-array options", () => {
    expect(
      isFormSchema(
        dropdown({ placeholder: "", options: "a,b", defaultValue: "" }),
      ),
    ).toBe(false);
  });
});

describe("validateFormSchema: validation rules", () => {
  it.each([
    ["a RegExp pattern", { pattern: /abc/ }],
    ["a non-string pattern", { pattern: 5 }],
    ["an invalid pattern string", { pattern: "(" }],
    ["an over-long pattern", { pattern: "a".repeat(501) }],
    ["a negative minLength", { minLength: -1 }],
    ["a fractional maxLength", { maxLength: 1.5 }],
    ["minLength above maxLength", { minLength: 5, maxLength: 1 }],
    ["min above max", { min: 5, max: 1 }],
    ["a non-boolean required", { required: "true" }],
    ["a non-boolean email", { email: 1 }],
    ["an unknown rule", { custom: "x" }],
  ])("rejects %s", (_label, validation) => {
    expect(isFormSchema(withField({ validation }))).toBe(false);
  });
});

describe("validateFormSchema: persisted data must be plain JSON", () => {
  it("rejects function values anywhere in a field", () => {
    const fnInConfig = withField({
      config: { placeholder: () => "x", defaultValue: "" },
    });
    const fnInField = withField({ onChange: () => undefined });
    const fnInLabel = withField({ label: function evil() {} });
    const fnInOptions = withField(
      {
        config: {
          placeholder: "",
          options: [{ label: "A", value: () => "a" }],
          defaultValue: "",
        },
      },
      "DROPDOWN",
    );

    for (const schema of [fnInConfig, fnInField, fnInLabel, fnInOptions]) {
      expect(isFormSchema(schema)).toBe(false);
      expect(errorsOf(schema).join()).toMatch(/plain JSON/);
    }
  });

  it("rejects function-like strings used as ids or as unknown keys", () => {
    expect(isFormSchema(withField({ id: "() => alert(1)" }))).toBe(false);
    expect(isFormSchema(withField({ "eval('x')": 1 }))).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a Date", new Date()],
    ["a RegExp", /x/],
    ["a Symbol", Symbol("x")],
    ["a BigInt", 1n],
    ["a Map", new Map()],
  ])("rejects %s as schema data", (_label, bad) => {
    expect(isFormSchema(withField({ label: bad }))).toBe(false);
  });

  it("rejects class instances", () => {
    class Evil {
      label = "x";
    }

    expect(isFormSchema(withField({ config: new Evil() }))).toBe(false);
  });

  it("rejects a __proto__ key from parsed JSON", () => {
    const schema = JSON.parse(
      '{"version":1,"fields":[],"__proto__":{"polluted":true}}',
    );

    expect(isFormSchema(schema)).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects extra keys on the schema and on fields", () => {
    expect(isFormSchema({ version: 1, fields: [], extra: true })).toBe(false);
    expect(isFormSchema(withField({ extra: true }))).toBe(false);
  });
});

describe("validateFormSchema: shape", () => {
  it.each([
    ["null", null],
    ["a string", "schema"],
    ["an array", []],
    ["a number", 1],
    ["missing fields", { version: 1 }],
    ["missing version", { fields: [] }],
    ["version 0", { version: 0, fields: [] }],
    ["a fractional version", { version: 1.5, fields: [] }],
    ["fields not an array", { version: 1, fields: {} }],
    ["a non-object field", { version: 1, fields: ["x"] }],
  ])("rejects %s", (_label, value) => {
    expect(isFormSchema(value)).toBe(false);
  });

  it("rejects non-null conditionalLogic until the engine exists", () => {
    expect(
      isFormSchema(withField({ conditionalLogic: { when: "x" } })),
    ).toBe(false);
  });

  it("rejects over-long labels and descriptions", () => {
    expect(isFormSchema(withField({ label: "l".repeat(201) }))).toBe(false);
    expect(isFormSchema(withField({ description: "d".repeat(501) }))).toBe(
      false,
    );
  });
});
