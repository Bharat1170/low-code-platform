import { z } from "zod";

import { isValidDateOnly } from "../utils/date-only.util.js";

/*
 * Server-side validation of a form builder draft schema (8.17.11).
 *
 * The client and server are separate packages that share no code, so the
 * rules of client/src/features/form-builder (types + form-schema.validate)
 * are restated here with zod. Keep the two in step when field types or
 * rules are added. The backend never trusts the client's own validation.
 *
 * The schema is pure data: nothing in it is ever evaluated or compiled
 * (patterns are only checked to be well-formed strings), and every
 * object is strict, so unknown keys (including $-operators, __proto__,
 * constructor and prototype) are rejected rather than stripped.
 */

/* Serialized draft size limit: a form definition, not a submission. The
 * global JSON body limit is 1 MB; a draft is capped well below it. */
export const MAX_DRAFT_SCHEMA_BYTES = 256 * 1024;
export const MAX_DRAFT_SCHEMA_FIELDS = 200;
const MAX_OPTIONS = 500;

const fieldId = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "Invalid field id");

const dateOnly = (name: string) =>
  z.string().refine(isValidDateOnly, `${name} must be a valid YYYY-MM-DD date`);

const validationRules = z
  .object({
    required: z.boolean().optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(0).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    pattern: z
      .string()
      .max(500)
      .refine((value) => {
        try {
          // Only checks that the string compiles; it is never run here.
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      }, "Pattern is not valid")
      .optional(),
    email: z.boolean().optional(),
    // NUMBER fields only: whole numbers.
    integer: z.boolean().optional(),
    // DATE fields only (checked per field below): real "YYYY-MM-DD" dates.
    minDate: dateOnly("minDate").optional(),
    maxDate: dateOnly("maxDate").optional(),
  })
  .strict()
  .superRefine((rules, ctx) => {
    if (
      rules.minLength !== undefined &&
      rules.maxLength !== undefined &&
      rules.minLength > rules.maxLength
    ) {
      ctx.addIssue({
        code: "custom",
        message: "minLength must not exceed maxLength",
      });
    }
    if (
      rules.min !== undefined &&
      rules.max !== undefined &&
      rules.min > rules.max
    ) {
      ctx.addIssue({
        code: "custom",
        message: "min must not exceed max",
      });
    }
    if (
      rules.minDate !== undefined &&
      rules.maxDate !== undefined &&
      rules.minDate > rules.maxDate
    ) {
      ctx.addIssue({
        code: "custom",
        message: "minDate must not exceed maxDate",
      });
    }
  });

const baseField = {
  id: fieldId,
  label: z.string().max(200),
  description: z.string().max(500),
  required: z.boolean(),
  validation: validationRules,
  conditionalLogic: z.null(),
};

const textConfig = z
  .object({
    placeholder: z.string().max(200),
    defaultValue: z.string().max(1000),
  })
  .strict();

export const MAX_TEXTAREA_LENGTH = 10_000;
export const MIN_RATING_SCALE = 3;
export const MAX_RATING_SCALE = 10;

const textareaConfig = z
  .object({
    placeholder: z.string().max(200),
    defaultValue: z.string().max(MAX_TEXTAREA_LENGTH),
  })
  .strict();

/* A number is kept as its decimal text, the same as it is submitted. */
export const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

const numberConfig = z
  .object({
    placeholder: z.string().max(200),
    defaultValue: z.union([
      z.literal(""),
      z.string().max(32).regex(NUMBER_TEXT, "defaultValue must be a number"),
    ]),
  })
  .strict();

const dropdownOption = z
  .object({
    label: z.string().min(1).max(200),
    value: z.string().min(1).max(200),
  })
  .strict();

const options = z.array(dropdownOption).max(MAX_OPTIONS);

/* Option values are unique; every default must name an option. */
const checkOptions = (
  config: { options: { value: string }[]; defaultValue: string | string[] },
  ctx: z.RefinementCtx,
): void => {
  const values = new Set<string>();

  for (const option of config.options) {
    if (values.has(option.value)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate option value "${option.value}"`,
      });
    }
    values.add(option.value);
  }

  const defaults = Array.isArray(config.defaultValue)
    ? config.defaultValue
    : config.defaultValue === ""
      ? []
      : [config.defaultValue];

  if (defaults.some((value) => !values.has(value))) {
    ctx.addIssue({
      code: "custom",
      message: "defaultValue must match an option value",
    });
  }

  if (new Set(defaults).size !== defaults.length) {
    ctx.addIssue({
      code: "custom",
      message: "defaultValue must not repeat an option",
    });
  }
};

const dropdownConfig = z
  .object({
    placeholder: z.string().max(200),
    options,
    defaultValue: z.string().max(1000),
  })
  .strict()
  .superRefine(checkOptions);

const radioConfig = z
  .object({
    options,
    defaultValue: z.string().max(1000),
  })
  .strict()
  .superRefine(checkOptions);

const multiSelectConfig = z
  .object({
    options,
    defaultValue: z.array(z.string().max(200)).max(MAX_OPTIONS),
  })
  .strict()
  .superRefine(checkOptions);

const ratingConfig = z
  .object({
    max: z.number().int().min(MIN_RATING_SCALE).max(MAX_RATING_SCALE),
    // 0 = no default rating.
    defaultValue: z.number().int().min(0).max(MAX_RATING_SCALE),
  })
  .strict()
  .refine((config) => config.defaultValue <= config.max, {
    message: "defaultValue must not exceed max",
  });

const checkboxConfig = z
  .object({
    defaultValue: z.boolean(),
  })
  .strict();

const dateConfig = z
  .object({
    defaultValue: z.union([z.literal(""), dateOnly("defaultValue")]),
  })
  .strict();

const formField = z.discriminatedUnion("type", [
  z
    .object({ ...baseField, type: z.literal("TEXT"), config: textConfig })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("EMAIL"), config: textConfig })
    .strict(),
  z
    .object({
      ...baseField,
      type: z.literal("DROPDOWN"),
      config: dropdownConfig,
    })
    .strict(),
  z
    .object({
      ...baseField,
      type: z.literal("CHECKBOX"),
      config: checkboxConfig,
    })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("DATE"), config: dateConfig })
    .strict(),
  z
    .object({
      ...baseField,
      type: z.literal("TEXTAREA"),
      config: textareaConfig,
    })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("NUMBER"), config: numberConfig })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("PHONE"), config: textConfig })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("URL"), config: textConfig })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("RADIO"), config: radioConfig })
    .strict(),
  z
    .object({
      ...baseField,
      type: z.literal("MULTI_SELECT"),
      config: multiSelectConfig,
    })
    .strict(),
  z
    .object({ ...baseField, type: z.literal("RATING"), config: ratingConfig })
    .strict(),
]);

export const formDraftSchema = z
  .object({
    version: z.number().int().min(1),
    fields: z.array(formField).max(MAX_DRAFT_SCHEMA_FIELDS),
  })
  .strict()
  .superRefine((schema, ctx) => {
    const seen = new Set<string>();

    schema.fields.forEach((field, index) => {
      if (field.validation.integer !== undefined && field.type !== "NUMBER") {
        ctx.addIssue({
          code: "custom",
          message: "integer is only valid for NUMBER fields",
          path: ["fields", index, "validation"],
        });
      }

      if (field.type === "NUMBER") {
        const value = field.config.defaultValue;
        const { min, max, integer } = field.validation;
        const number = Number(value);

        if (
          value !== "" &&
          ((min !== undefined && number < min) ||
            (max !== undefined && number > max) ||
            (integer === true && !Number.isInteger(number)))
        ) {
          ctx.addIssue({
            code: "custom",
            message: "defaultValue must satisfy the number rules",
            path: ["fields", index, "config", "defaultValue"],
          });
        }
      }

      const { minDate, maxDate } = field.validation;

      if (field.type !== "DATE") {
        if (minDate !== undefined || maxDate !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: "minDate and maxDate are only valid for DATE fields",
            path: ["fields", index, "validation"],
          });
        }
        return;
      }

      const value = field.config.defaultValue;
      if (
        value !== "" &&
        ((minDate !== undefined && value < minDate) ||
          (maxDate !== undefined && value > maxDate))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "defaultValue must be within minDate and maxDate",
          path: ["fields", index, "config", "defaultValue"],
        });
      }
    });

    for (const field of schema.fields) {
      if (seen.has(field.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate field id "${field.id}"`,
        });
      }
      seen.add(field.id);
    }

    if (
      Buffer.byteLength(JSON.stringify(schema), "utf8") >
      MAX_DRAFT_SCHEMA_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Draft schema must not exceed ${MAX_DRAFT_SCHEMA_BYTES} bytes`,
      });
    }
  });

export type FormDraftSchema = z.infer<typeof formDraftSchema>;
