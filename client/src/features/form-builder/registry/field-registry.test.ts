import { describe, expect, it } from "vitest";

import {
  FIELD_REGISTRY,
  getFieldRegistryEntry,
  isFieldType,
  listFieldRegistryEntries,
} from "./field-registry.ts";
import { FIELD_TYPES } from "../types/form-builder.types.ts";

const hasFunction = (value: unknown): boolean => {
  if (typeof value === "function") return true;
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasFunction);
  }
  return false;
};

describe("field registry", () => {
  it("contains exactly the five supported field types", () => {
    expect(Object.keys(FIELD_REGISTRY).sort()).toEqual([
      "CHECKBOX",
      "DATE",
      "DROPDOWN",
      "EMAIL",
      "TEXT",
    ]);
    expect([...FIELD_TYPES].sort()).toEqual(Object.keys(FIELD_REGISTRY).sort());
    expect(listFieldRegistryEntries().map((e) => e.type)).toEqual([
      "TEXT",
      "EMAIL",
      "DROPDOWN",
      "CHECKBOX",
      "DATE",
    ]);
  });

  it("looks up the correct definition for each type", () => {
    for (const type of FIELD_TYPES) {
      const entry = getFieldRegistryEntry(type);

      expect(entry.type).toBe(type);
      expect(entry).toBe(FIELD_REGISTRY[type]);
    }

    expect(getFieldRegistryEntry("EMAIL")).toMatchObject({
      label: "Email",
      icon: "email",
    });
  });

  it("has the right TEXT defaults", () => {
    expect(FIELD_REGISTRY.TEXT).toMatchObject({
      label: "Text",
      icon: "text",
      defaultConfig: { placeholder: "", defaultValue: "" },
      defaultValidation: {},
    });
  });

  it("has the right EMAIL defaults", () => {
    expect(FIELD_REGISTRY.EMAIL).toMatchObject({
      label: "Email",
      icon: "email",
      defaultConfig: { placeholder: "", defaultValue: "" },
      defaultValidation: { email: true },
    });
  });

  it("has the right DROPDOWN defaults", () => {
    expect(FIELD_REGISTRY.DROPDOWN).toMatchObject({
      label: "Dropdown",
      icon: "dropdown",
      defaultConfig: {
        placeholder: "Select an option",
        defaultValue: "",
      },
      defaultValidation: {},
    });
    expect(FIELD_REGISTRY.DROPDOWN.defaultConfig.options).toEqual([
      { label: "Option 1", value: "option-1" },
      { label: "Option 2", value: "option-2" },
    ]);
  });

  it("has the right CHECKBOX defaults", () => {
    expect(FIELD_REGISTRY.CHECKBOX).toMatchObject({
      label: "Checkbox",
      icon: "checkbox",
      defaultConfig: { defaultValue: false },
      defaultValidation: {},
    });
  });

  it("represents dropdown options as JSON-safe data", () => {
    const options = FIELD_REGISTRY.DROPDOWN.defaultConfig.options;

    expect(JSON.parse(JSON.stringify(options))).toEqual(options);
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(["label", "value"]);
      expect(typeof option.label).toBe("string");
      expect(typeof option.value).toBe("string");
    }
  });

  it("is plain serializable data with no functions or React elements", () => {
    expect(hasFunction(FIELD_REGISTRY)).toBe(false);
    expect(JSON.parse(JSON.stringify(FIELD_REGISTRY))).toEqual(
      FIELD_REGISTRY,
    );
    for (const entry of listFieldRegistryEntries()) {
      expect(typeof entry.icon).toBe("string");
    }
  });

  it("is deeply frozen so defaults cannot be mutated", () => {
    expect(Object.isFrozen(FIELD_REGISTRY)).toBe(true);
    expect(Object.isFrozen(FIELD_REGISTRY.DROPDOWN.defaultConfig)).toBe(true);
    expect(Object.isFrozen(FIELD_REGISTRY.DROPDOWN.defaultConfig.options)).toBe(
      true,
    );
    expect(() => {
      (
        FIELD_REGISTRY.DROPDOWN.defaultConfig.options as unknown as unknown[]
      ).push({ label: "x", value: "x" });
    }).toThrow();
  });

  it("rejects unknown and prototype-style field types", () => {
    for (const bad of [
      "NUMBER",
      "text",
      "",
      "constructor",
      "__proto__",
      "toString",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(isFieldType(bad)).toBe(false);
    }

    expect(() =>
      getFieldRegistryEntry("NUMBER" as unknown as "TEXT"),
    ).toThrow(/Unknown field type/);
    expect(() =>
      getFieldRegistryEntry("constructor" as unknown as "TEXT"),
    ).toThrow(/Unknown field type/);
  });
});
