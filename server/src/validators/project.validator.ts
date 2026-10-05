import { z } from "zod";

/*
 * Client-editable project fields only. organizationId and createdBy come
 * from the authenticated request context; _id and timestamps are managed
 * by the server. Both schemas are strict, so any other key is rejected.
 */
const projectFields = {
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(150, "Project name must not exceed 150 characters"),

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

  // Allowed business statuses are intentionally not defined here yet.
  status: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Status is required")
    .max(50, "Status must not exceed 50 characters"),
};

export const createProjectSchema = z
  .object({
    name: projectFields.name,
    slug: projectFields.slug,
    status: projectFields.status,
    description: projectFields.description.optional(),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object(projectFields)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
