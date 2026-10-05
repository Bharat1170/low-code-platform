import type { Request, Response } from "express";

import { getAuthContext } from "../middleware/auth.middleware.js";
import {
  getFormSubmission as getFormSubmissionService,
  listFormSubmissions as listFormSubmissionsService,
  submitForm as submitFormService,
} from "../services/form-submission.service.js";
import { sendSuccess } from "../utils/response.js";
import {
  createSubmissionSchema,
  submissionFormIdParamSchema,
} from "../validators/form-submission.validator.js";
import {
  listSubmissionsQuerySchema,
  submissionIdParamSchema,
} from "../validators/form-submission.reading.js";

export const submitForm = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = submissionFormIdParamSchema.parse(req.params);

  const input = createSubmissionSchema.parse(req.body);

  const submission = await submitFormService(auth, id, input, {
    ipAddress: req.ip ?? "unknown",
    userAgent: (req.get("user-agent") ?? "unknown").slice(0, 1000),
  });

  sendSuccess(res, 201, "Form submitted successfully", { submission });
};

export const listSubmissions = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = submissionFormIdParamSchema.parse(req.params);

  const query = listSubmissionsQuerySchema.parse(req.query);

  const result = await listFormSubmissionsService(auth, id, query);

  sendSuccess(res, 200, "Submissions retrieved successfully", result);
};

export const getSubmission = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id, submissionId } = submissionIdParamSchema.parse(req.params);

  const submission = await getFormSubmissionService(auth, id, submissionId);

  sendSuccess(res, 200, "Submission retrieved successfully", { submission });
};
