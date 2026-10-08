/*
 * Server-side validation of submitted data against a published
 * FormVersion.schemaSnapshot (8.17.15). The server is authoritative; the
 * client's own validation is only a convenience.
 *
 * Rules: unknown field ids are rejected; required, minLength, maxLength,
 * min/max (numeric), email and pattern are enforced; types are never
 * coerced. The snapshot is read defensively (it is stored as Mixed), and
 * nothing in it or in the submission is ever evaluated: a pattern is only
 * compiled with RegExp inside try/catch.
 *
 * Returns messages keyed by field id; an empty object means valid.
 */

import { isValidDateOnly } from "./date-only.util.js";

/* Pragmatic check, not full RFC 5322 (same as the client). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Bounds the work a pattern can do on a long value. */
const MAX_PATTERN_INPUT = 10_000;

export type SubmittedData = Record<string, string | boolean | string[]>;

/* Digits with optional +, spaces, dashes, dots and brackets; 7–15 digits. */
const PHONE_PATTERN = /^\+?[0-9 ().-]{7,25}$/;
const MAX_URL_LENGTH = 2048;
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

const isPhone = (value: string): boolean => {
  if (!PHONE_PATTERN.test(value)) return false;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 7 && digits <= 15;
};

/* Absolute http(s) URL only; javascript:, data: etc. are rejected. */
const isWebUrl = (value: string): boolean => {
  if (value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
  } catch {
    return false;
  }
};

const optionValues = (field: Record<string, unknown>): Set<string> => {
  const config = isRecord(field.config) ? field.config : {};
  const options = Array.isArray(config.options) ? config.options : [];
  return new Set(
    options.flatMap((o) => (isRecord(o) && typeof o.value === "string" ? [o.value] : [])),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const compilePattern = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern);
  } catch {
    // Cannot happen for a published version (patterns are checked when
    // saving); a broken one is ignored rather than failing every submit.
    return null;
  }
};

const labelOf = (field: Record<string, unknown>): string =>
  typeof field.label === "string" && field.label.trim() !== ""
    ? field.label.trim()
    : "This field";

const validateText = (
  field: Record<string, unknown>,
  value: string,
  label: string,
): string | null => {
  const rules = isRecord(field.validation) ? field.validation : {};

  if (field.type === "EMAIL" || rules.email === true) {
    if (!EMAIL_PATTERN.test(value)) {
      return `${label} must be a valid email address`;
    }
  }

  const minLength = finiteNumber(rules.minLength);
  if (minLength !== undefined && value.length < minLength) {
    return `${label} must be at least ${minLength} characters`;
  }

  const maxLength = finiteNumber(rules.maxLength);
  if (maxLength !== undefined && value.length > maxLength) {
    return `${label} must be at most ${maxLength} characters`;
  }

  const min = finiteNumber(rules.min);
  const max = finiteNumber(rules.max);
  if (min !== undefined || max !== undefined) {
    const number = Number(value);

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
      (value.length > MAX_PATTERN_INPUT || !expression.test(value))
    ) {
      return `${label} is not in the expected format`;
    }
  }

  return null;
};

const validateField = (
  field: Record<string, unknown>,
  value: unknown,
): string | null => {
  const label = labelOf(field);
  const rules = isRecord(field.validation) ? field.validation : {};
  const required = field.required === true || rules.required === true;
  const provided = value !== undefined;

  switch (field.type) {
    case "CHECKBOX":
      if (provided && typeof value !== "boolean") {
        return `${label} must be true or false`;
      }
      return required && value !== true ? `${label} must be checked` : null;

    case "DATE": {
      if (provided && typeof value !== "string") {
        return `${label} must be a date`;
      }

      const text = typeof value === "string" ? value : "";

      if (text === "") {
        return required ? `${label} is required` : null;
      }

      // Strict YYYY-MM-DD; "2026-02-31" is not rolled over to March.
      if (!isValidDateOnly(text)) {
        return `${label} must be a valid date (YYYY-MM-DD)`;
      }

      const minDate = typeof rules.minDate === "string" ? rules.minDate : undefined;
      const maxDate = typeof rules.maxDate === "string" ? rules.maxDate : undefined;

      if (minDate !== undefined && text < minDate) {
        return `${label} must be on or after ${minDate}`;
      }
      if (maxDate !== undefined && text > maxDate) {
        return `${label} must be on or before ${maxDate}`;
      }

      return null;
    }

    case "MULTI_SELECT": {
      if (
        provided &&
        !(Array.isArray(value) && value.every((item) => typeof item === "string"))
      ) {
        return `${label} must be a list of options`;
      }

      const chosen = Array.isArray(value) ? (value as string[]) : [];

      if (chosen.length === 0) {
        return required ? `${label} is required` : null;
      }

      const allowed = optionValues(field);
      if (new Set(chosen).size !== chosen.length) {
        return `${label} must not repeat an option`;
      }
      if (!chosen.every((item) => allowed.has(item))) {
        return `${label} must only contain the available options`;
      }

      // min / max count how many options are chosen.
      const min = finiteNumber(rules.min);
      const max = finiteNumber(rules.max);
      if (min !== undefined && chosen.length < min) {
        return `${label} needs at least ${min} selections`;
      }
      if (max !== undefined && chosen.length > max) {
        return `${label} allows at most ${max} selections`;
      }

      return null;
    }

    case "TEXT":
    case "EMAIL":
    case "TEXTAREA":
    case "NUMBER":
    case "PHONE":
    case "URL":
    case "DROPDOWN":
    case "RADIO":
    case "RATING": {
      if (provided && typeof value !== "string") {
        return `${label} must be text`;
      }

      const text = typeof value === "string" ? value : "";

      if (text.trim() === "") {
        return required ? `${label} is required` : null;
      }

      if (field.type === "DROPDOWN" || field.type === "RADIO") {
        return optionValues(field).has(text)
          ? null
          : `${label} must be one of the available options`;
      }

      if (field.type === "RATING") {
        const config = isRecord(field.config) ? field.config : {};
        const scale = finiteNumber(config.max) ?? 5;
        const rating = Number(text);

        return /^\d{1,2}$/.test(text) && rating >= 1 && rating <= scale
          ? null
          : `${label} must be a rating from 1 to ${scale}`;
      }

      if (field.type === "NUMBER") {
        if (!NUMBER_TEXT.test(text) || text.length > 32) {
          return `${label} must be a number`;
        }
        if (rules.integer === true && !Number.isInteger(Number(text))) {
          return `${label} must be a whole number`;
        }
      }

      if (field.type === "PHONE" && !isPhone(text)) {
        return `${label} must be a valid phone number`;
      }

      if (field.type === "URL" && !isWebUrl(text)) {
        return `${label} must be a valid web address (http or https)`;
      }

      return validateText(field, text, label);
    }

    default:
      // A field type this server does not know cannot be validated.
      return `${label} has an unsupported field type`;
  }
};

export const validateSubmissionData = (
  schemaSnapshot: unknown,
  data: SubmittedData,
): Record<string, string> => {
  const errors: Record<string, string> = {};
  const rawFields = isRecord(schemaSnapshot) ? schemaSnapshot.fields : undefined;
  const fields = Array.isArray(rawFields) ? rawFields : [];
  const known = new Set<string>();

  for (const field of fields) {
    if (!isRecord(field) || typeof field.id !== "string") continue;

    known.add(field.id);

    const message = validateField(
      field,
      Object.prototype.hasOwnProperty.call(data, field.id)
        ? data[field.id]
        : undefined,
    );
    if (message !== null) {
      errors[field.id] = message;
    }
  }

  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      errors[key] = "Unknown field";
    }
  }

  return errors;
};
