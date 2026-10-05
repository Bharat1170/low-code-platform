import type { Request, Response } from "express";
import { z } from "zod";

import { getAuthContext } from "../middleware/auth.middleware.js";

import { MAX_FORM_LIST_LIMIT } from "../repositories/form.repository.js";

import {
  createForm as createFormService,
  deleteForm as deleteFormService,
  getFormById as getFormByIdService,
  getFormBySlug as getFormBySlugService,
  listForms as listFormsService,
  updateForm as updateFormService,
} from "../services/form.service.js";

import {
  createFormSchema,
  updateFormSchema,
} from "../validators/form.validator.js";

import { publishForm as publishFormService } from "../services/form-publish.service.js";

import { publishRequestBodySchema } from "../validators/form-publish.validator.js";

import { getPublishedForm as getPublishedFormService } from "../services/published-form.service.js";

import { sendSuccess } from "../utils/response.js";

/*
 * Request-boundary schemas local to this controller. All are strict, so
 * an organizationId (or anything else unexpected) in params or query is
 * rejected rather than ignored. The slug and projectId rules are taken
 * from the form validator so they cannot drift.
 *
 * The route layer (8.17.6) must register GET /slug/:slug before
 * GET /:id so "slug" is never captured as an id.
 */
const formIdParamSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Invalid form ID"),
  })
  .strict();

const formSlugParamSchema = z
  .object({
    slug: createFormSchema.shape.slug,
  })
  .strict();

const listFormsQuerySchema = z
  .object({
    projectId: createFormSchema.shape.projectId.optional(),

    limit: z.coerce
      .number()
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(
        MAX_FORM_LIST_LIMIT,
        `Limit must not exceed ${MAX_FORM_LIST_LIMIT}`,
      )
      .optional(),

    skip: z.coerce
      .number()
      .int("Skip must be an integer")
      .min(0, "Skip must not be negative")
      .optional(),
  })
  .strict();

export const createForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const input = createFormSchema.parse(req.body);

  const form = await createFormService(auth, input);

  sendSuccess(res, 201, "Form created successfully", { form });
};

export const listForms = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const options = listFormsQuerySchema.parse(req.query);

  const forms = await listFormsService(auth, options);

  sendSuccess(res, 200, "Forms retrieved successfully", { forms });
};

export const getFormById = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = formIdParamSchema.parse(req.params);

  const form = await getFormByIdService(auth, id);

  sendSuccess(res, 200, "Form retrieved successfully", { form });
};

export const getFormBySlug = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { slug } = formSlugParamSchema.parse(req.params);

  const form = await getFormBySlugService(auth, slug);

  sendSuccess(res, 200, "Form retrieved successfully", { form });
};

export const updateForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = formIdParamSchema.parse(req.params);

  const input = updateFormSchema.parse(req.body);

  const form = await updateFormService(auth, id, input);

  sendSuccess(res, 200, "Form updated successfully", { form });
};

export const deleteForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = formIdParamSchema.parse(req.params);

  await deleteFormService(auth, id);

  sendSuccess(res, 200, "Form deleted successfully");
};

export const publishForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = formIdParamSchema.parse(req.params);

  // No body is accepted: what is published is decided by the server.
  publishRequestBodySchema.parse(req.body ?? {});

  const result = await publishFormService(auth, id, {
    ipAddress: req.ip ?? "unknown",
    userAgent: (req.get("user-agent") ?? "unknown").slice(0, 1000),
  });

  sendSuccess(res, 200, "Form published successfully", result);
};

export const getPublishedForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = formIdParamSchema.parse(req.params);

  const published = await getPublishedFormService(auth, id);

  sendSuccess(res, 200, "Published form retrieved successfully", {
    published,
  });
};
