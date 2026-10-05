import { z } from "zod";

import { formDraftSchema } from "./form-draft-schema.validator.js";

export const FORM_STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
] as const;

/*
 * Client-editable form fields only. organizationId and createdBy come
 * from the authenticated request context; _id and timestamps are managed
 * by the server. Both schemas are strict, so any other key is rejected.
 * Whether projectId exists in the organization is checked by later layers.
 */
const formFields = {
  name: z
    .string()
    .trim()
    .min(1, "Form name is required")
    .max(150, "Form name must not exceed 150 characters"),

  description: z
    .string()
    .trim()
    .max(500, "Description must not exceed 500 characters"),

  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Slug is required")
    .max(150, "Slug must not exceed 150 characters")
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug may only contain lowercase letters, numbers and single hyphens",
    ),

  status: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z.enum(FORM_STATUSES, {
        message: "Status must be DRAFT, PUBLISHED or ARCHIVED",
      }),
    ),

  projectId: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, "Invalid project ID"),
};

export const createFormSchema = z
  .object({
    name: formFields.name,
    slug: formFields.slug,
    status: formFields.status,
    projectId: formFields.projectId,
    description: formFields.description.optional(),
  })
  .strict();

export type CreateFormInput = z.infer<typeof createFormSchema>;

/*
 * draftSchema (the builder's current draft) is saved on its own: an
 * autosave request carries ONLY draftSchema, so it can never change the
 * form's name, slug, status or project. Metadata edits stay a separate
 * kind of update. Validation of the draft itself is in
 * form-draft-schema.validator.ts.
 */
export const updateFormSchema = z
  .object({ ...formFields, draftSchema: formDraftSchema })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  })
  .refine(
    (value) =>
      value.draftSchema === undefined || Object.keys(value).length === 1,
    {
      message: "draftSchema must be sent on its own",
      path: ["draftSchema"],
    },
  );

export type UpdateFormInput = z.infer<typeof updateFormSchema>;
