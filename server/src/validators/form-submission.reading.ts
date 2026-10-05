import { z } from "zod";

import { submissionFormIdParamSchema } from "./form-submission.validator.js";

/*
 * Request validation for reading submissions (8.17.16).
 *
 * Query strings are strict: unknown keys (operators, nested objects,
 * __proto__, sort/filter attempts) are rejected, never ignored. Only
 * submittedAt can be sorted on, so there is no sort-field parameter;
 * direction is `order`. The parsed result is the only thing that reaches
 * the repository.
 */

export const submissionIdParamSchema = submissionFormIdParamSchema
  .extend({
    submissionId: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Invalid submission ID"),
  })
  .strict();

export const DEFAULT_SUBMISSION_PAGE_SIZE = 25;
export const MAX_SUBMISSION_PAGE_SIZE = 100;
/* Keeps skip() bounded; narrow with filters to reach older entries. */
export const MAX_SUBMISSION_PAGE = 10_000;

const queryInteger = (name: string, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, `${name} must be a positive integer`)
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1, `${name} must be at least 1`)
        .max(max, `${name} must not exceed ${max}`),
    );

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const queryDate = (name: string) =>
  z
    .string()
    .refine(
      (value) =>
        (DATE_ONLY.test(value) || DATE_TIME.test(value)) &&
        !Number.isNaN(new Date(value).getTime()),
      `${name} must be an ISO date (YYYY-MM-DD) or date-time`,
    )
    .refine(
      // Rejects impossible dates such as 2026-02-31 that would roll over.
      (value) => {
        if (!DATE_ONLY.test(value)) return true;
        const parsed = new Date(value);
        return (
          !Number.isNaN(parsed.getTime()) &&
          parsed.toISOString().startsWith(value)
        );
      },
      `${name} is not a real date`,
    );

export const listSubmissionsQuerySchema = z
  .object({
    page: queryInteger("page", MAX_SUBMISSION_PAGE).optional(),
    pageSize: queryInteger("pageSize", MAX_SUBMISSION_PAGE_SIZE).optional(),
    version: queryInteger("version", 1_000_000).optional(),
    submittedFrom: queryDate("submittedFrom").optional(),
    submittedTo: queryDate("submittedTo").optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict()
  .refine(
    (query) => {
      if (query.submittedFrom === undefined || query.submittedTo === undefined) {
        return true;
      }
      const from = new Date(query.submittedFrom).getTime();
      const to = new Date(query.submittedTo).getTime();
      // An unparseable value is reported by its own rule above.
      return Number.isNaN(from) || Number.isNaN(to) || from <= to;
    },
    {
      message: "submittedFrom must not be after submittedTo",
      path: ["submittedFrom"],
    },
  );

export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;
