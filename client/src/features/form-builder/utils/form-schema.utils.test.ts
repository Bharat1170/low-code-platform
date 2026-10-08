import { describe, expect, it } from "vitest";

import { FIELD_REGISTRY } from "../registry/field-registry.ts";
import {
  FIELD_TYPES,
  FORM_SCHEMA_VERSION,
  type FormSchema,
} from "../types/form-builder.types.ts";
import {
  addField,
  areJsonValuesEqual,
  areSchemasEqual,
  createEmptyFormSchema,
  createFieldDefinition,
  findDuplicateFieldIds,
  findFieldById,
  generateFieldId,
  hasUniqueFieldIds,
  isValidFieldId,
  removeField,
  updateField,
} from "./form-schema.utils.ts";

const hasFunction = (value: unknown): boolean => {
  if (typeof value === "function") return true;
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasFunction);
  }
  return false;
};

const schemaWithFields = (): FormSchema => {
  let schema = createEmptyFormSchema();
  schema = addField(schema, createFieldDefinition("TEXT", "name"));
  schema = addField(schema, createFieldDefinition("EMAIL", "email"));
  schema = addField(schema, createFieldDefinition("DROPDOWN", "country"));
  return schema;
};

describe("createFieldDefinition", () => {
  it("creates a TEXT field", () => {
    const field = createFieldDefinition("TEXT", "full-name");

    expect(field).toEqual({
      id: "full-name",
      type: "TEXT",
      label: "Text field",
      description: "",
      required: false,
      config: { placeholder: "", defaultValue: "" },
      validation: {},
      conditionalLogic: null,
    });
  });

  it("creates an EMAIL field", () => {
    const field = createFieldDefinition("EMAIL", "email");

    expect(field.type).toBe("EMAIL");
    expect(field.config).toEqual({ placeholder: "", defaultValue: "" });
    expect(field.validation).toEqual({ email: true });
  });

  it("creates a DROPDOWN field", () => {
    const field = createFieldDefinition("DROPDOWN", "choice");

    expect(field.type).toBe("DROPDOWN");
    expect(field.config.options).toHaveLength(2);
    expect(field.config.placeholder).toBe("Select an option");
    expect(field.config.defaultValue).toBe("");
  });

  it("creates a CHECKBOX field", () => {
    const field = createFieldDefinition("CHECKBOX", "agree");

    expect(field.type).toBe("CHECKBOX");
    expect(field.config).toEqual({ defaultValue: false });
  });

  it("creates every registered type", () => {
    for (const type of FIELD_TYPES) {
      expect(createFieldDefinition(type, `f-${type}`).type).toBe(type);
    }
  });

  it("generates a valid unique id when none is given", () => {
    const a = createFieldDefinition("TEXT");
    const b = createFieldDefinition("TEXT");

    expect(isValidFieldId(a.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(isValidFieldId(generateFieldId())).toBe(true);
  });

  it("rejects an invalid id", () => {
    for (const id of ["", "1abc", "has space", "a;b", "x".repeat(65), "$set"]) {
      expect(() => createFieldDefinition("TEXT", id)).toThrow(
        /Invalid field id/,
      );
    }
  });

  it("rejects an unknown field type", () => {
    expect(() =>
      createFieldDefinition("SIGNATURE" as unknown as "TEXT", "n"),
    ).toThrow(/Unknown field type/);
  });

  it("does not mutate or return the registry defaults", () => {
    const before = JSON.stringify(FIELD_REGISTRY);
    const field = createFieldDefinition("DROPDOWN", "choice");

    field.config.options.push({ label: "Extra", value: "extra" });
    field.config.placeholder = "changed";
    field.validation.required = true;

    expect(JSON.stringify(FIELD_REGISTRY)).toBe(before);
    expect(field.config).not.toBe(FIELD_REGISTRY.DROPDOWN.defaultConfig);
    expect(field.config.options).not.toBe(
      FIELD_REGISTRY.DROPDOWN.defaultConfig.options,
    );
    expect(field.validation).not.toBe(
      FIELD_REGISTRY.DROPDOWN.defaultValidation,
    );
  });

  it("does not share options between two dropdown fields", () => {
    const a = createFieldDefinition("DROPDOWN", "a");
    const b = createFieldDefinition("DROPDOWN", "b");

    a.config.options.push({ label: "Only A", value: "only-a" });
    a.config.options[0].label = "Changed";

    expect(a.config.options).not.toBe(b.config.options);
    expect(b.config.options).toHaveLength(2);
    expect(b.config.options[0].label).toBe("Option 1");
  });

  it("produces JSON-serializable fields without functions", () => {
    for (const type of FIELD_TYPES) {
      const field = createFieldDefinition(type, "f");

      expect(hasFunction(field)).toBe(false);
      expect(JSON.parse(JSON.stringify(field))).toEqual(field);
    }
  });
});

describe("schema helpers", () => {
  it("creates an empty schema with the current version", () => {
    expect(createEmptyFormSchema()).toEqual({
      version: FORM_SCHEMA_VERSION,
      fields: [],
    });
  });

  it("detects unique and duplicate field ids", () => {
    const schema = schemaWithFields();

    expect(hasUniqueFieldIds(schema)).toBe(true);
    expect(findDuplicateFieldIds(schema)).toEqual([]);

    const duplicated: FormSchema = {
      ...schema,
      fields: [...schema.fields, createFieldDefinition("TEXT", "name")],
    };

    expect(hasUniqueFieldIds(duplicated)).toBe(false);
    expect(findDuplicateFieldIds(duplicated)).toEqual(["name"]);
  });

  it("addField rejects a duplicate or invalid id", () => {
    const schema = schemaWithFields();

    expect(() =>
      addField(schema, createFieldDefinition("TEXT", "name")),
    ).toThrow(/Duplicate field id/);
    expect(() =>
      addField(schema, {
        ...createFieldDefinition("TEXT", "ok"),
        id: "bad id",
      }),
    ).toThrow(/Invalid field id/);
  });

  it("addField does not mutate the original schema", () => {
    const schema = createEmptyFormSchema();
    const snapshot = JSON.stringify(schema);

    const updated = addField(schema, createFieldDefinition("TEXT", "a"));

    expect(JSON.stringify(schema)).toBe(snapshot);
    expect(schema.fields).toHaveLength(0);
    expect(updated.fields).toHaveLength(1);
    expect(updated).not.toBe(schema);
  });

  it("addField stores a copy of the field", () => {
    const field = createFieldDefinition("DROPDOWN", "d");
    const schema = addField(createEmptyFormSchema(), field);

    field.config.options.push({ label: "late", value: "late" });

    const stored = findFieldById(schema, "d");
    expect(stored?.type).toBe("DROPDOWN");
    if (stored?.type === "DROPDOWN") {
      expect(stored.config.options).toHaveLength(2);
    }
  });

  it("findFieldById returns the field, or undefined when missing", () => {
    const schema = schemaWithFields();

    expect(findFieldById(schema, "email")?.type).toBe("EMAIL");
    expect(findFieldById(schema, "missing")).toBeUndefined();
    expect(findFieldById(schema, "constructor")).toBeUndefined();
    expect(findFieldById(createEmptyFormSchema(), "email")).toBeUndefined();
  });

  it("removeField is immutable", () => {
    const schema = schemaWithFields();
    const snapshot = JSON.stringify(schema);

    const updated = removeField(schema, "email");

    expect(JSON.stringify(schema)).toBe(snapshot);
    expect(schema.fields).toHaveLength(3);
    expect(updated.fields.map((f) => f.id)).toEqual(["name", "country"]);
    expect(updated.fields[0]).toBe(schema.fields[0]);
  });

  it("removeField with an unknown id changes nothing", () => {
    const schema = schemaWithFields();

    expect(removeField(schema, "missing").fields).toHaveLength(3);
  });

  it("updateField is immutable", () => {
    const schema = schemaWithFields();
    const snapshot = JSON.stringify(schema);

    const updated = updateField(schema, "name", {
      label: "Full name",
      required: true,
      config: { placeholder: "Jane Doe" },
    });

    expect(JSON.stringify(schema)).toBe(snapshot);
    expect(findFieldById(schema, "name")?.label).toBe("Text field");

    const changed = findFieldById(updated, "name");
    expect(changed).toMatchObject({
      label: "Full name",
      required: true,
      config: { placeholder: "Jane Doe", defaultValue: "" },
    });
    // Untouched fields are reused, not copied.
    expect(findFieldById(updated, "email")).toBe(
      findFieldById(schema, "email"),
    );
  });

  it("updateField never changes id or type", () => {
    const schema = schemaWithFields();

    const updated = updateField(schema, "name", {
      id: "hijacked",
      type: "EMAIL",
      label: "Renamed",
    } as unknown as { label: string });

    expect(findFieldById(updated, "name")?.type).toBe("TEXT");
    expect(findFieldById(updated, "hijacked")).toBeUndefined();
  });

  it("updateField ignores config keys the field does not have", () => {
    const schema = schemaWithFields();

    const updated = updateField(schema, "name", {
      config: { options: [{ label: "x", value: "x" }] },
    });

    expect(Object.keys(findFieldById(updated, "name")?.config ?? {}).sort()).toEqual([
      "defaultValue",
      "placeholder",
    ]);
  });

  it("updateField does not share objects with the changes", () => {
    const schema = schemaWithFields();
    const options = [{ label: "A", value: "a" }];

    const updated = updateField(schema, "country", { config: { options } });
    options.push({ label: "B", value: "b" });
    options[0].label = "mutated";

    const field = findFieldById(updated, "country");
    expect(field?.type === "DROPDOWN" && field.config.options).toEqual([
      { label: "A", value: "a" },
    ]);
  });

  it("updateField rejects function values", () => {
    const schema = schemaWithFields();

    expect(() =>
      updateField(schema, "name", {
        config: { placeholder: (() => "x") as unknown as string },
      }),
    ).toThrow();
  });

  it("updateField with an unknown id returns an equal schema", () => {
    const schema = schemaWithFields();

    expect(updateField(schema, "missing", { label: "x" })).toEqual(schema);
  });
});

describe("validation configuration", () => {
  it("stays JSON-serializable with string patterns", () => {
    let schema = addField(
      createEmptyFormSchema(),
      createFieldDefinition("TEXT", "code"),
    );
    schema = updateField(schema, "code", {
      validation: {
        required: true,
        minLength: 2,
        maxLength: 10,
        min: 0,
        max: 100,
        pattern: "^[A-Z]{2,10}$",
        email: false,
      },
    });

    const validation = findFieldById(schema, "code")?.validation;

    expect(JSON.parse(JSON.stringify(validation))).toEqual(validation);
    expect(typeof validation?.pattern).toBe("string");
    expect(validation?.pattern).not.toBeInstanceOf(RegExp);
  });
});

describe("schema equality", () => {
  it("treats structurally equal schemas as equal regardless of key order", () => {
    const a = schemaWithFields();
    const b = JSON.parse(JSON.stringify(a)) as FormSchema;
    const reordered = {
      fields: b.fields.map((f) => ({ ...f, config: { ...f.config } })),
      version: b.version,
    } as FormSchema;

    expect(areSchemasEqual(a, b)).toBe(true);
    expect(areSchemasEqual(a, reordered)).toBe(true);
    expect(areSchemasEqual(a, a)).toBe(true);
  });

  it("detects any difference", () => {
    const a = schemaWithFields();

    expect(areSchemasEqual(a, updateField(a, "name", { label: "x" }))).toBe(false);
    expect(areSchemasEqual(a, removeField(a, "name"))).toBe(false);
    expect(
      areSchemasEqual(a, updateField(a, "country", { config: { options: [] } })),
    ).toBe(false);
    expect(areSchemasEqual(a, { ...a, version: 2 })).toBe(false);
    expect(
      areSchemasEqual(a, { ...a, fields: [...a.fields].reverse() }),
    ).toBe(false);
  });

  it("compares primitives, arrays and objects strictly", () => {
    expect(areJsonValuesEqual(1, 1)).toBe(true);
    expect(areJsonValuesEqual(1, "1")).toBe(false);
    expect(areJsonValuesEqual(null, {})).toBe(false);
    expect(areJsonValuesEqual([], {})).toBe(false);
    expect(areJsonValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(areJsonValuesEqual({ a: undefined }, { b: undefined })).toBe(false);
    expect(areJsonValuesEqual([1, [2]], [1, [2]])).toBe(true);
  });
});