import type { Request, Response } from "express";
import { z } from "zod";

import { getAuthContext } from "../middleware/auth.middleware.js";

import { MAX_PROJECT_LIST_LIMIT } from "../repositories/project.repository.js";

import {
  createProject as createProjectService,
  deleteProject as deleteProjectService,
  getProject as getProjectService,
  listProjects as listProjectsService,
  updateProject as updateProjectService,
} from "../services/project.service.js";

import {
  createProjectSchema,
  updateProjectSchema,
} from "../validators/project.validator.js";

import { sendSuccess } from "../utils/response.js";

/*
 * Request-boundary schemas local to this controller. Both are strict, so
 * an organizationId (or anything else unexpected) in params or query is
 * rejected rather than ignored.
 */
const projectIdParamSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-f\d]{24}$/i, "Invalid project ID"),
  })
  .strict();

const listProjectsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int("Limit must be an integer")
      .min(1, "Limit must be at least 1")
      .max(
        MAX_PROJECT_LIST_LIMIT,
        `Limit must not exceed ${MAX_PROJECT_LIST_LIMIT}`,
      )
      .optional(),

    skip: z.coerce
      .number()
      .int("Skip must be an integer")
      .min(0, "Skip must not be negative")
      .optional(),
  })
  .strict();

export const createProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const input = createProjectSchema.parse(req.body);

  const project = await createProjectService(auth, input);

  sendSuccess(res, 201, "Project created successfully", {
    project,
  });
};

export const listProjects = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const options = listProjectsQuerySchema.parse(req.query);

  const projects = await listProjectsService(auth, options);

  sendSuccess(res, 200, "Projects retrieved successfully", {
    projects,
  });
};

export const getProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = projectIdParamSchema.parse(req.params);

  const project = await getProjectService(auth, id);

  sendSuccess(res, 200, "Project retrieved successfully", {
    project,
  });
};

export const updateProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = projectIdParamSchema.parse(req.params);

  const input = updateProjectSchema.parse(req.body);

  const project = await updateProjectService(auth, id, input);

  sendSuccess(res, 200, "Project updated successfully", {
    project,
  });
};

export const deleteProject = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const auth = getAuthContext(req);

  const { id } = projectIdParamSchema.parse(req.params);

  await deleteProjectService(auth, id);

  sendSuccess(res, 200, "Project deleted successfully");
};
