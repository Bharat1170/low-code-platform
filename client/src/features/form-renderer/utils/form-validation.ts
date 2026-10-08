import type { FormFieldDefinition } from "../../form-builder/types/form-builder.types.ts";
import { isFieldType } from "../../form-builder/registry/field-registry.ts";
import { isValidDateOnly } from "../../form-builder/utils/date-only.ts";
import { NUMBER_TEXT } from "../../form-builder/utils/form-schema.validate.ts";
import type {
  FieldErrors,
  FieldValue,
  FieldValues,
} from "../types/form-renderer.types.ts";

/*
 * Client-side validation of entered values against the rules the CURRENT
 * schema supports: required, minLength, maxLength, min, max, email and
 * pattern. It is a convenience for the person filling in the form; the
 * server must still validate. Nothing here evaluates code: a pattern is
 * only compiled with RegExp inside try/catch.
 */

/* Pragmatic check, not full RFC 5322. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Bounds the work a pattern can do on a very long value. */
const MAX_PATTERN_INPUT = 10_000;

/* Same rules as the server (form-submission-validation.util.ts). */
const PHONE_PATTERN = /^\+?[0-9 ().-]{7,25}$/;
const MAX_URL_LENGTH = 2048;

export const isPhoneNumber = (value: string): boolean => {
  if (!PHONE_PATTERN.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15;
};

/* Absolute http(s) URL only; javascript:, data: etc. are rejected. */
export const isWebUrl = (value: string): boolean => {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname !== ""
    );
  } catch {
    return false;
  }
};

/* 1..max for a rating field (the scale defaults to 5). */
export const ratingScale = (field: FormFieldDefinition): number => {
  const config: unknown = field.config;
  const max = isRecord(config) ? config.max : undefined;
  return typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 10
    ? max
    : 5;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/* A broken pattern is a form-definition problem, not the user's: skipped. */
const compilePattern = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
};

export const fieldLabel = (field: FormFieldDefinition): string => {
  const label = typeof field.label === "string" ? field.label.trim() : "";
  return label === "" ? "This field" : label;
};

export const isRequired = (field: FormFieldDefinition): boolean => {
  const rules: unknown = field.validation;
  return (
    field.required === true || (isRecord(rules) && rules.required === true)
  );
};

/* Value shown before the person types anything. Safe for broken configs. */
export const defaultValueFor = (field: FormFieldDefinition): FieldValue => {
  const config: unknown = field.config;
  const fallback = isRecord(config) ? config.defaultValue : undefined;

  if (field.type === "CHECKBOX") {
    return fallback === true;
  }

  if (field.type === "MULTI_SELECT") {
    return Array.isArray(fallback)
      ? fallback.filter((item): item is string => typeof item === "string")
      : [];
  }

  if (field.type === "RATING") {
    // 0 means "no default rating".
    return typeof fallback === "number" && Number.isInteger(fallback) && fallback > 0
      ? String(fallback)
      : "";
  }

  return typeof fallback === "string" ? fallback : "";
};

export const isSupportedField = (
  field: unknown,
): field is FormFieldDefinition =>
  isRecord(field) && typeof field.id === "string" && isFieldType(field.type);

export const dropdownOptions = (
  field: FormFieldDefinition,
): { label: string; value: string }[] => {
  const config: unknown = field.config;
  const options = isRecord(config) ? config.options : undefined;

  if (!Array.isArray(options)) return [];

  return options.filter(
    (option): option is { label: string; value: string } =>
      isRecord(option) &&
      typeof option.label === "string" &&
      typeof option.value === "string",
  );
};

/* Returns a user-facing message, or null when the value is acceptable. */
export const validateField = (
  field: FormFieldDefinition,
  value: FieldValue | undefined,
): string | null => {
  const label = fieldLabel(field);
  const rulesValue: unknown = field.validation;
  const rules: Record<string, unknown> = isRecord(rulesValue) ? rulesValue : {};
  const required = isRequired(field);

  if (field.type === "CHECKBOX") {
    return required && value !== true ? `${label} must be checked` : null;
  }

  if (field.type === "MULTI_SELECT") {
    const chosen = Array.isArray(value) ? value : [];
    if (chosen.length === 0) {
      return required ? `${label} is required` : null;
    }
    const allowed = new Set(dropdownOptions(field).map((option) => option.value));
    if (!chosen.every((item) => allowed.has(item))) {
      return `${label} must only contain the available options`;
    }
    const minCount = finiteNumber(rules.min);
    const maxCount = finiteNumber(rules.max);
    if (minCount !== undefined && chosen.length < minCount) {
      return `${label} needs at least ${minCount} selections`;
    }
    if (maxCount !== undefined && chosen.length > maxCount) {
      return `${label} allows at most ${maxCount} selections`;
    }
    return null;
  }

  const text = typeof value === "string" ? value : "";

  if (field.type === "DATE") {
    if (text === "") {
      return required ? `${label} is required` : null;
    }
    if (!isValidDateOnly(text)) {
      return `${label} must be a valid date`;
    }
    if (typeof rules.minDate === "string" && text < rules.minDate) {
      return `${label} must be on or after ${rules.minDate}`;
    }
    if (typeof rules.maxDate === "string" && text > rules.maxDate) {
      return `${label} must be on or before ${rules.maxDate}`;
    }
    return null;
  }

  if (text.trim() === "") {
    return required ? `${label} is required` : null;
  }

  if (field.type === "DROPDOWN" || field.type === "RADIO") {
    return dropdownOptions(field).some((option) => option.value === text)
      ? null
      : `${label} must be one of the available options`;
  }

  if (field.type === "RATING") {
    const scale = ratingScale(field);
    const rating = Number(text);
    return /^\d{1,2}$/.test(text) && rating >= 1 && rating <= scale
      ? null
      : `${label} must be a rating from 1 to ${scale}`;
  }

  if (field.type === "NUMBER") {
    if (text.length > 32 || !NUMBER_TEXT.test(text)) {
      return `${label} must be a number`;
    }
    if (rules.integer === true && !Number.isInteger(Number(text))) {
      return `${label} must be a whole number`;
    }
  }

  if (field.type === "PHONE" && !isPhoneNumber(text)) {
    return `${label} must be a valid phone number`;
  }

  if (field.type === "URL" && !isWebUrl(text)) {
    return `${label} must be a valid web address (http or https)`;
  }

  if (field.type === "EMAIL" || rules.email === true) {
    if (!EMAIL_PATTERN.test(text)) {
      return `${label} must be a valid email address`;
    }
  }

  const minLength = finiteNumber(rules.minLength);
  if (minLength !== undefined && text.length < minLength) {
    return `${label} must be at least ${minLength} characters`;
  }

  const maxLength = finiteNumber(rules.maxLength);
  if (maxLength !== undefined && text.length > maxLength) {
    return `${label} must be at most ${maxLength} characters`;
  }

  const min = finiteNumber(rules.min);
  const max = finiteNumber(rules.max);
  if (min !== undefined || max !== undefined) {
    const number = Number(text);

    if (!Number.isFinite(number)) {
      return `${label} must be a number`;
    }
    if (min !== undefined && number < min) {
      return `${label} must be at least ${min}`;
    }
    if (max !== undefined && number > max) {
      return `${label} must be at most ${max}`;
    }
  }

  if (typeof rules.pattern === "string" && rules.pattern !== "") {
    const expression = compilePattern(rules.pattern);

    if (
      expression !== null &&
      (text.length > MAX_PATTERN_INPUT || !expression.test(text))
    ) {
      return `${label} is not in the expected format`;
    }
  }

  return null;
};

export const validateForm = (
  fields: readonly FormFieldDefinition[],
  values: FieldValues,
): FieldErrors => {
  const errors: FieldErrors = {};

  for (const field of fields) {
    if (!isSupportedField(field)) continue;

    const message = validateField(field, values[field.id]);
    if (message !== null) {
      errors[field.id] = message;
    }
  }

  return errors;
};
