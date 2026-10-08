import type { Request, Response } from "express";
import { z } from "zod";

import { submitPublicForm as submitPublicFormService } from "../services/form-submission.service.js";
import { getPublicForm as getPublicFormService } from "../services/published-form.service.js";
import { AppError } from "../utils/errors.js";
import { isValidPublicId } from "../utils/public-id.util.js";
import { sendSuccess } from "../utils/response.js";
import { createSubmissionSchema } from "../validators/form-submission.validator.js";

/*
 * Share-link endpoints (no authentication). The publicId in the URL is the
 * only thing that selects a form; the body of a submission is exactly
 * { data }, so organizationId, formId, formVersionId, submittedBy and any
 * other key are rejected by the strict schema.
 */

const publicIdParamSchema = z.object({ publicId: z.string() }).strict();

/* A malformed id gets the same 404 as an unknown one. */
const readPublicId = (req: Request): string => {
  const { publicId } = publicIdParamSchema.parse(req.params);

  if (!isValidPublicId(publicId)) {
    throw new AppError(404, "FORM_NOT_FOUND", "This form is not available");
  }

  return publicId;
};

export const getPublicForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const form = await getPublicFormService(readPublicId(req));

  // Published versions are immutable, but the link may move to a new
  // version at any time, so shared caches must revalidate.
  res.setHeader("Cache-Control", "no-store");

  sendSuccess(res, 200, "Form retrieved successfully", { form });
};

export const submitPublicForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const publicId = readPublicId(req);
  const input = createSubmissionSchema.parse(req.body);

  const submission = await submitPublicFormService(publicId, input, {
    ipAddress: req.ip ?? "unknown",
    userAgent: (req.get("user-agent") ?? "unknown").slice(0, 1000),
  });

  sendSuccess(res, 201, "Your response has been submitted", { submission });
};
