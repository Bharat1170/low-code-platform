import { z } from "zod";

import {
  MAX_DRAFT_SCHEMA_BYTES,
  MAX_DRAFT_SCHEMA_FIELDS,
} from "./form-draft-schema.validator.js";

/*
 * Request-boundary validation of POST /api/forms/:id/submissions (8.17.15).
 *
 * The body is exactly { data }. organizationId, formId, formVersionId,
 * version, submittedBy, submittedAt and anything else are rejected by the
 * strict object, never ignored. `data` maps field ids to strings or
 * booleans only. Checking the values against the published schema is the
 * service's job; this layer only guarantees a safe, bounded shape.
 */

/* Same shape as a stored field id (form-draft-schema.validator.ts). */
const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/* Names that must never be used as keys, even if a form defines them. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const MAX_SUBMISSION_FIELDS = MAX_DRAFT_SCHEMA_FIELDS;
export const MAX_SUBMISSION_STRING_LENGTH = 10_000;
export const MAX_SUBMISSION_BYTES = MAX_DRAFT_SCHEMA_BYTES;
export const MAX_SUBMISSION_LIST_ITEMS = 500;
export const MAX_SUBMISSION_LIST_ITEM_LENGTH = 200;

export const submissionFormIdParamSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Invalid form ID"),
  })
  .strict();

const submissionData = z
  .unknown()
  .superRefine((value, ctx) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "data must be an object" });
      return;
    }

    // Own keys only; an own "__proto__" (from JSON.parse) is listed here.
    const keys = Object.keys(value);

    if (keys.length > MAX_SUBMISSION_FIELDS) {
      ctx.addIssue({
        code: "custom",
        message: `A submission must not contain more than ${MAX_SUBMISSION_FIELDS} fields`,
      });
      return;
    }

    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key) || !FIELD_ID_PATTERN.test(key)) {
        ctx.addIssue({
          code: "custom",
          message: "Invalid field id",
          path: [key.slice(0, 64)],
        });
        continue;
      }

      const entry = (value as Record<string, unknown>)[key];

      if (typeof entry === "string") {
        if (entry.length > MAX_SUBMISSION_STRING_LENGTH) {
          ctx.addIssue({
            code: "custom",
            message: `Value must not exceed ${MAX_SUBMISSION_STRING_LENGTH} characters`,
            path: [key],
          });
        }
      } else if (Array.isArray(entry)) {
        // Multi-select: a bounded list of short strings, nothing nested.
        if (
          entry.length > MAX_SUBMISSION_LIST_ITEMS ||
          !entry.every(
            (item) =>
              typeof item === "string" &&
              item.length <= MAX_SUBMISSION_LIST_ITEM_LENGTH,
          )
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Value must be a list of options",
            path: [key],
          });
        }
      } else if (typeof entry !== "boolean") {
        ctx.addIssue({
          code: "custom",
          message: "Value must be a string, a boolean or a list of options",
          path: [key],
        });
      }
    }
  })
  .transform((value) => {
    // Fresh arrays: the stored value never shares the parsed body's.
    const copy: SubmissionData = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, SubmissionValue>,
    )) {
      copy[key] = Array.isArray(entry) ? [...entry] : entry;
    }
    return copy;
  });

export const createSubmissionSchema = z
  .object({ data: submissionData })
  .strict();

/* One submitted value: text, a checkbox, or a multi-select's chosen values. */
export type SubmissionValue = string | boolean | string[];
export type SubmissionData = Record<string, SubmissionValue>;

export type CreateSubmissionInput = {
  data: SubmissionData;
};
