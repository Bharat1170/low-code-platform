import { isFieldType } from "../registry/field-registry.ts";
import type {
  FieldType,
  FormSchema,
} from "../types/form-builder.types.ts";
import { isValidDateOnly } from "./date-only.ts";
import { isValidFieldId } from "./form-schema.utils.ts";

/*
 * Runtime check that an UNTRUSTED value (for example parsed JSON from
 * the API) is a well-formed FormSchema. It only inspects data; nothing
 * in the value is ever executed or evaluated. It is strict: unknown
 * keys, unknown field types, non-JSON values (functions, RegExp, Date,
 * undefined, NaN, ...) and duplicate field ids are all rejected.
 */

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const MAX_LABEL = 200;
const MAX_DESCRIPTION = 500;
const MAX_PATTERN = 500;

const FIELD_KEYS = [
  "id",
  "type",
  "label",
  "description",
  "required",
  "config",
  "validation",
  "conditionalLogic",
];

const CONFIG_KEYS: Record<FieldType, readonly string[]> = {
  TEXT: ["placeholder", "defaultValue"],
  EMAIL: ["placeholder", "defaultValue"],
  DROPDOWN: ["placeholder", "options", "defaultValue"],
  CHECKBOX: ["defaultValue"],
  DATE: ["defaultValue"],
};

const VALIDATION_KEYS = [
  "required",
  "minLength",
  "maxLength",
  "min",
  "max",
  "pattern",
  "email",
  "minDate",
  "maxDate",
];

const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
};

/* True for null, booleans, strings, finite numbers, arrays and plain
 * objects of those (recursively). */
const isJsonSafe = (value: unknown): boolean => {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) {
        return value.every(isJsonSafe);
      }
      return (
        isPlainObject(value) && Object.values(value).every(isJsonSafe)
      );
    default:
      return false;
  }
};

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean => {
  return Object.keys(value).every((key) => allowed.includes(key));
};

const isString = (value: unknown, max?: number): value is string =>
  typeof value === "string" && (max === undefined || value.length <= max);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const checkValidation = (
  validation: unknown,
  where: string,
  errors: string[],
): void => {
  if (!isPlainObject(validation) || !hasOnlyKeys(validation, VALIDATION_KEYS)) {
    errors.push(`${where}: validation must be an object of known rules`);
    return;
  }

  const { required, minLength, maxLength, min, max, pattern, email } =
    validation;
  const { minDate, maxDate } = validation;

  for (const [name, bound] of [
    ["minDate", minDate],
    ["maxDate", maxDate],
  ] as const) {
    if (bound !== undefined && !isValidDateOnly(bound)) {
      errors.push(`${where}: validation.${name} must be a valid YYYY-MM-DD date`);
    }
  }
  if (
    isValidDateOnly(minDate) &&
    isValidDateOnly(maxDate) &&
    minDate > maxDate
  ) {
    errors.push(`${where}: validation.minDate must not exceed maxDate`);
  }

  if (required !== undefined && typeof required !== "boolean") {
    errors.push(`${where}: validation.required must be a boolean`);
  }
  if (email !== undefined && typeof email !== "boolean") {
    errors.push(`${where}: validation.email must be a boolean`);
  }
  if (minLength !== undefined && !isNonNegativeInteger(minLength)) {
    errors.push(`${where}: validation.minLength must be a non-negative integer`);
  }
  if (maxLength !== undefined && !isNonNegativeInteger(maxLength)) {
    errors.push(`${where}: validation.maxLength must be a non-negative integer`);
  }
  if (
    isNonNegativeInteger(minLength) &&
    isNonNegativeInteger(maxLength) &&
    minLength > maxLength
  ) {
    errors.push(`${where}: validation.minLength must not exceed maxLength`);
  }
  if (min !== undefined && !(typeof min === "number" && Number.isFinite(min))) {
    errors.push(`${where}: validation.min must be a finite number`);
  }
  if (max !== undefined && !(typeof max === "number" && Number.isFinite(max))) {
    errors.push(`${where}: validation.max must be a finite number`);
  }
  if (typeof min === "number" && typeof max === "number" && min > max) {
    errors.push(`${where}: validation.min must not exceed max`);
  }
  if (pattern !== undefined) {
    if (!isString(pattern, MAX_PATTERN)) {
      errors.push(`${where}: validation.pattern must be a string`);
    } else {
      try {
        // Only checks that the string compiles; it is never run on input here.
        new RegExp(pattern);
      } catch {
        errors.push(`${where}: validation.pattern is not a valid pattern`);
      }
    }
  }
};

const checkConfig = (
  type: FieldType,
  config: unknown,
  where: string,
  errors: string[],
): void => {
  if (!isPlainObject(config) || !hasOnlyKeys(config, CONFIG_KEYS[type])) {
    errors.push(`${where}: config has missing or unknown keys for ${type}`);
    return;
  }

  const { placeholder, defaultValue, options } = config;

  if (type === "CHECKBOX") {
    if (typeof defaultValue !== "boolean") {
      errors.push(`${where}: config.defaultValue must be a boolean`);
    }
    return;
  }

  if (type === "DATE") {
    if (defaultValue !== "" && !isValidDateOnly(defaultValue)) {
      errors.push(
        `${where}: config.defaultValue must be empty or a valid YYYY-MM-DD date`,
      );
    }
    return;
  }

  if (!isString(defaultValue, 1000)) {
    errors.push(`${where}: config.defaultValue must be a string`);
  }

  if (type === "TEXT" || type === "EMAIL") {
    if (!isString(placeholder, 200)) {
      errors.push(`${where}: config.placeholder must be a string`);
    }
    return;
  }

  // DROPDOWN
  if (!isString(placeholder, 200)) {
    errors.push(`${where}: config.placeholder must be a string`);
  }

  if (!Array.isArray(options)) {
    errors.push(`${where}: config.options must be an array`);
    return;
  }

  const values = new Set<string>();

  for (const option of options as unknown[]) {
    if (
      !isPlainObject(option) ||
      !hasOnlyKeys(option, ["label", "value"]) ||
      !isString(option.label, 200) ||
      option.label.length === 0 ||
      !isString(option.value, 200) ||
      option.value.length === 0
    ) {
      errors.push(
        `${where}: each option must be { label, value } with non-empty strings`,
      );
      return;
    }

    if (values.has(option.value)) {
      errors.push(`${where}: duplicate option value "${option.value}"`);
    }
    values.add(option.value);
  }

  if (
    typeof defaultValue === "string" &&
    defaultValue !== "" &&
    !values.has(defaultValue)
  ) {
    errors.push(`${where}: config.defaultValue must match an option value`);
  }
};

export const validateFormSchema = (
  value: unknown,
): SchemaValidationResult => {
  const errors: string[] = [];

  if (!isJsonSafe(value)) {
    return {
      valid: false,
      errors: [
        "Schema must be plain JSON (no functions, RegExp, undefined or non-finite numbers)",
      ],
    };
  }

  if (!isPlainObject(value) || !hasOnlyKeys(value, ["version", "fields"])) {
    return {
      valid: false,
      errors: ["Schema must be an object with only version and fields"],
    };
  }

  if (!isNonNegativeInteger(value.version) || value.version < 1) {
    errors.push("version must be a positive integer");
  }

  if (!Array.isArray(value.fields)) {
    return { valid: false, errors: [...errors, "fields must be an array"] };
  }

  const seen = new Set<string>();

  (value.fields as unknown[]).forEach((field, index) => {
    const where = `fields[${index}]`;

    if (!isPlainObject(field) || !hasOnlyKeys(field, FIELD_KEYS)) {
      errors.push(`${where}: must be an object with known keys only`);
      return;
    }

    if (!isValidFieldId(field.id)) {
      errors.push(`${where}: invalid id`);
    } else if (seen.has(field.id)) {
      errors.push(`${where}: duplicate id "${field.id}"`);
    } else {
      seen.add(field.id);
    }

    if (!isString(field.label, MAX_LABEL)) {
      errors.push(`${where}: label must be a string`);
    }
    if (!isString(field.description, MAX_DESCRIPTION)) {
      errors.push(`${where}: description must be a string`);
    }
    if (typeof field.required !== "boolean") {
      errors.push(`${where}: required must be a boolean`);
    }
    if (field.conditionalLogic !== null) {
      errors.push(`${where}: conditionalLogic must be null`);
    }

    checkValidation(field.validation, where, errors);

    if (!isFieldType(field.type)) {
      errors.push(`${where}: unknown field type`);
      return;
    }

    checkConfig(field.type, field.config, where, errors);

    const rules = isPlainObject(field.validation) ? field.validation : {};
    if (field.type !== "DATE") {
      if (rules.minDate !== undefined || rules.maxDate !== undefined) {
        errors.push(`${where}: minDate and maxDate are only valid for DATE fields`);
      }
    } else if (
      isPlainObject(field.config) &&
      isValidDateOnly(field.config.defaultValue)
    ) {
      const value = field.config.defaultValue;
      const { minDate, maxDate } = rules;
      if (
        (isValidDateOnly(minDate) && value < minDate) ||
        (isValidDateOnly(maxDate) && value > maxDate)
      ) {
        errors.push(`${where}: config.defaultValue must be within minDate and maxDate`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
};

export const isFormSchema = (value: unknown): value is FormSchema => {
  return validateFormSchema(value).valid;
};
