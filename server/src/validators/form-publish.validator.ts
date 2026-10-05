import { z } from "zod";

import { AppError } from "../utils/errors.js";
import {
  formDraftSchema,
  type FormDraftSchema,
} from "./form-draft-schema.validator.js";

/*
 * Publish-time validation (8.17.13).
 *
 * The draft is validated again, on the server, with the same strict rules
 * as saving (structure, field types, ids, duplicate ids, options,
 * validation rules, pattern well-formedness, unknown/unsafe keys, size and
 * field-count limits, conditionalLogic). Publishing then adds the rules
 * that a saved draft may still break but a published form must not.
 *
 * Conditional logic: the schema only supports `conditionalLogic: null`
 * today (formDraftSchema rejects anything else), so there are no field
 * references, operators or dependency graphs to resolve or cycle-check
 * yet. A non-null value is rejected, which also rejects any attempted
 * reference or circular dependency.
 *
 * The result is a fresh, validated copy. The caller's draft is never
 * modified or repaired.
 */

const publishableSchema = formDraftSchema.superRefine((schema, ctx) => {
  if (schema.fields.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "A form needs at least one field to be published",
      path: ["fields"],
    });
  }

  schema.fields.forEach((field, index) => {
    if (field.label.trim() === "") {
      ctx.addIssue({
        code: "custom",
        message: "Field label is required",
        path: ["fields", index, "label"],
      });
    }

    if (field.type === "DROPDOWN" && field.config.options.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A dropdown needs at least one option",
        path: ["fields", index, "config", "options"],
      });
    }
  });
});

export const validateSchemaForPublish = (draft: unknown): FormDraftSchema => {
  const result = publishableSchema.safeParse(draft);

  if (result.success) {
    return result.data;
  }

  const fields: Record<string, string> = {};

  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_";

    if (!(key in fields)) {
      fields[key] = issue.message;
    }
  }

  throw new AppError(
    400,
    "FORM_SCHEMA_INVALID",
    "The form cannot be published because its schema is invalid",
    fields,
  );
};

/* The publish request carries no body: the server decides what is published. */
export const publishRequestBodySchema = z.object({}).strict();
