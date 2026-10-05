import mongoose from "mongoose";

import {
  createProject as createProjectRecord,
  deleteProjectByIdAndOrganization,
  findProjectByIdAndOrganization,
  findProjectsByOrganization,
  updateProjectByIdAndOrganization,
  type FindProjectsOptions,
} from "../repositories/project.repository.js";

import type { IProject } from "../models/project.model.js";

import type { AuthContext } from "../types/auth.types.js";

import type {
  CreateProjectInput,
  UpdateProjectInput,
} from "../validators/project.validator.js";

import { AppError } from "../utils/errors.js";

/*
 * Project service (8.16.4).
 *
 * Tenant scope and creator identity come only from the authenticated
 * AuthContext, never from the request payload. The validated inputs
 * contain editable fields only (the validators are strict).
 *
 * Slug uniqueness is enforced solely by the unique
 * { organizationId, slug } index. A duplicate-key error from MongoDB is
 * deliberately not caught here; the error-handling layer translates it.
 *
 * A missing project and a project owned by another organization produce
 * the same PROJECT_NOT_FOUND error, so IDs of other tenants are never
 * revealed.
 */

const projectNotFound = (): AppError => {
  return new AppError(
    404,
    "PROJECT_NOT_FOUND",
    "Project not found",
  );
};

const toOrganizationId = (
  auth: AuthContext,
): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(auth.organizationId);
};

export const createProject = async (
  auth: AuthContext,
  input: CreateProjectInput,
): Promise<IProject> => {
  return createProjectRecord(toOrganizationId(auth), {
    name: input.name,
    description: input.description ?? "",
    slug: input.slug,
    status: input.status,
    createdBy: new mongoose.Types.ObjectId(auth.userId),
  });
};

export const listProjects = async (
  auth: AuthContext,
  options: FindProjectsOptions = {},
): Promise<IProject[]> => {
  return findProjectsByOrganization(
    toOrganizationId(auth),
    options,
  );
};

export const getProject = async (
  auth: AuthContext,
  projectId: string,
): Promise<IProject> => {
  const project = await findProjectByIdAndOrganization(
    new mongoose.Types.ObjectId(projectId),
    toOrganizationId(auth),
  );

  if (!project) {
    throw projectNotFound();
  }

  return project;
};

export const updateProject = async (
  auth: AuthContext,
  projectId: string,
  input: UpdateProjectInput,
): Promise<IProject> => {
  const project = await updateProjectByIdAndOrganization(
    new mongoose.Types.ObjectId(projectId),
    toOrganizationId(auth),
    input,
  );

  if (!project) {
    throw projectNotFound();
  }

  return project;
};

export const deleteProject = async (
  auth: AuthContext,
  projectId: string,
): Promise<void> => {
  const deleted = await deleteProjectByIdAndOrganization(
    new mongoose.Types.ObjectId(projectId),
    toOrganizationId(auth),
  );

  if (!deleted) {
    throw projectNotFound();
  }
};
