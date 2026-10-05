import {
  FIELD_TYPES,
  type FieldRegistry,
  type FieldRegistryEntry,
  type FieldType,
} from "../types/form-builder.types.ts";

/*
 * The single source of truth for field metadata. The palette, canvas,
 * renderer and property panel must read from here instead of repeating
 * type names, labels or defaults.
 *
 * The registry is plain serializable data (icons are identifiers, not
 * components) and is deeply frozen so no caller can mutate the defaults.
 * Use createFieldDefinition() to get a fresh, independent field.
 */

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }

  return value;
};

export const FIELD_REGISTRY: FieldRegistry = deepFreeze({
  TEXT: {
    type: "TEXT",
    label: "Text",
    icon: "text",
    category: "basic",
    defaultLabel: "Text field",
    defaultConfig: { placeholder: "", defaultValue: "" },
    defaultValidation: {},
  },

  EMAIL: {
    type: "EMAIL",
    label: "Email",
    icon: "email",
    category: "basic",
    defaultLabel: "Email",
    defaultConfig: { placeholder: "", defaultValue: "" },
    defaultValidation: { email: true },
  },

  DROPDOWN: {
    type: "DROPDOWN",
    label: "Dropdown",
    icon: "dropdown",
    category: "choice",
    defaultLabel: "Dropdown",
    defaultConfig: {
      placeholder: "Select an option",
      options: [
        { label: "Option 1", value: "option-1" },
        { label: "Option 2", value: "option-2" },
      ],
      defaultValue: "",
    },
    defaultValidation: {},
  },

  CHECKBOX: {
    type: "CHECKBOX",
    label: "Checkbox",
    icon: "checkbox",
    category: "choice",
    defaultLabel: "Checkbox",
    defaultConfig: { defaultValue: false },
    defaultValidation: {},
  },

  DATE: {
    type: "DATE",
    label: "Date",
    icon: "date",
    category: "basic",
    defaultLabel: "Date field",
    defaultConfig: { defaultValue: "" },
    defaultValidation: {},
  },
});

/* Type guard for untrusted values. Prototype keys are never field types. */
export const isFieldType = (value: unknown): value is FieldType => {
  return (
    typeof value === "string" &&
    (FIELD_TYPES as readonly string[]).includes(value)
  );
};

/* Typed lookup. Throws for an unknown type instead of returning junk. */
export const getFieldRegistryEntry = <T extends FieldType>(
  type: T,
): FieldRegistryEntry<T> => {
  if (!isFieldType(type)) {
    throw new Error(`Unknown field type: ${String(type)}`);
  }

  return FIELD_REGISTRY[type];
};

/* All entries in a stable order, for building the palette. */
export const listFieldRegistryEntries = (): FieldRegistryEntry<FieldType>[] => {
  return FIELD_TYPES.map((type) => FIELD_REGISTRY[type]);
};
