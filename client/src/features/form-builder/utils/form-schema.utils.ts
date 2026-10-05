import {
  getFieldRegistryEntry,
} from "../registry/field-registry.ts";
import {
  FORM_SCHEMA_VERSION,
  type FieldConfig,
  type FieldDefinitionByType,
  type FieldType,
  type FormFieldDefinition,
  type FormSchema,
  type ValidationConfig,
} from "../types/form-builder.types.ts";

/*
 * Pure, immutable helpers over FormSchema. Nothing here mutates its
 * arguments, and nothing executes persisted data.
 */

/* Letters, digits, "_" and "-", starting with a letter. */
const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const isValidFieldId = (id: unknown): id is string => {
  return typeof id === "string" && FIELD_ID_PATTERN.test(id);
};

export const generateFieldId = (): string => {
  return `field_${crypto.randomUUID().replaceAll("-", "")}`;
};

export const createEmptyFormSchema = (): FormSchema => {
  return { version: FORM_SCHEMA_VERSION, fields: [] };
};

/*
 * Creates a brand-new field from the registry defaults. Config and
 * validation are deep-copied, so no two fields (and not the registry)
 * ever share a mutable object.
 */
export const createFieldDefinition = <T extends FieldType>(
  type: T,
  id: string = generateFieldId(),
): FieldDefinitionByType[T] => {
  if (!isValidFieldId(id)) {
    throw new Error("Invalid field id");
  }

  const entry = getFieldRegistryEntry(type);

  const field = {
    id,
    type: entry.type,
    label: entry.defaultLabel,
    description: "",
    required: false,
    config: structuredClone(entry.defaultConfig),
    validation: structuredClone(entry.defaultValidation),
    conditionalLogic: null,
  };

  // The registry maps each type to a matching config, so the object
  // built above is exactly the definition for T.
  return field as unknown as FieldDefinitionByType[T];
};

/*
 * Deterministic structural equality for JSON data (key order does not
 * matter). Used to decide whether the builder schema differs from the
 * last saved one.
 */
export const areJsonValuesEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => areJsonValuesEqual(item, b[index]))
    );
  }

  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null
  ) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key) =>
          Object.hasOwn(b, key) &&
          areJsonValuesEqual(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
          ),
      )
    );
  }

  return false;
};

export const areSchemasEqual = (a: FormSchema, b: FormSchema): boolean => {
  return areJsonValuesEqual(a, b);
};

export const hasUniqueFieldIds =(schema: FormSchema): boolean => {
  return findDuplicateFieldIds(schema).length === 0;
};

export const findDuplicateFieldIds = (schema: FormSchema): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const field of schema.fields) {
    if (seen.has(field.id)) {
      duplicates.add(field.id);
    }
    seen.add(field.id);
  }

  return [...duplicates];
};

/* Returns undefined when no field has the id. */
export const findFieldById = (
  schema: FormSchema,
  id: string,
): FormFieldDefinition | undefined => {
  return schema.fields.find((field) => field.id === id);
};

/* Appends a field. Throws if its id is invalid or already used. */
export const addField = (
  schema: FormSchema,
  field: FormFieldDefinition,
): FormSchema => {
  if (!isValidFieldId(field.id)) {
    throw new Error("Invalid field id");
  }

  if (findFieldById(schema, field.id)) {
    throw new Error(`Duplicate field id: ${field.id}`);
  }

  return {
    ...schema,
    fields: [...schema.fields, structuredClone(field)],
  };
};

export const removeField = (
  schema: FormSchema,
  id: string,
): FormSchema => {
  return {
    ...schema,
    fields: schema.fields.filter((field) => field.id !== id),
  };
};

/*
 * Editable parts of a field. `id` and `type` can never change.
 * `config` is partial and only keys the field's config already has are
 * applied, so a TEXT field cannot gain dropdown `options`.
 */
export interface FieldChanges {
  label?: string;
  description?: string;
  required?: boolean;
  validation?: ValidationConfig;
  config?: Partial<FieldConfig>;
}

/*
 * Returns a new schema with the field changed. Unknown ids leave the
 * schema as is. Change values are deep-copied (structuredClone also
 * rejects functions), so the result never shares objects with `changes`.
 */
export const updateField = (
  schema: FormSchema,
  id: string,
  changes: FieldChanges,
): FormSchema => {
  const safe = structuredClone(changes);

  return {
    ...schema,
    fields: schema.fields.map((field): FormFieldDefinition => {
      if (field.id !== id) {
        return field;
      }

      const config: Record<string, unknown> = { ...field.config };

      for (const [key, value] of Object.entries(safe.config ?? {})) {
        if (Object.hasOwn(field.config, key)) {
          config[key] = value;
        }
      }

      return {
        ...field,
        label: safe.label ?? field.label,
        description: safe.description ?? field.description,
        required: safe.required ?? field.required,
        validation: safe.validation ?? field.validation,
        config,
      } as unknown as FormFieldDefinition;
    }),
  };
};
