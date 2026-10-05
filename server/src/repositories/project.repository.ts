import { type ClientSession, type Types } from "mongoose";

import {
  Project,
  type IProject,
} from "../models/project.model.js";

/*
 * Project queries (8.16.3).
 *
 * Projects are tenant-owned. organizationId is always an explicit argument
 * supplied by the caller (derived from the authenticated request context),
 * never read from a project input object. Every query for a specific
 * project matches BOTH _id and organizationId, so a project id belonging
 * to another organization simply does not match. Never look a project up
 * by _id alone.
 */

export const DEFAULT_PROJECT_LIST_LIMIT = 20;
export const MAX_PROJECT_LIST_LIMIT = 100;

export type CreateProjectData = Pick<
  IProject,
  "name" | "description" | "slug" | "status" | "createdBy"
>;

export type UpdateProjectData = Partial<
  Pick<IProject, "name" | "description" | "slug" | "status">
>;

export interface FindProjectsOptions {
  limit?: number;
  skip?: number;
}

export const createProject = async (
  organizationId: Types.ObjectId,
  data: CreateProjectData,
  dbSession?: ClientSession,
): Promise<IProject> => {
  const project = new Project({
    organizationId,
    name: data.name,
    description: data.description,
    slug: data.slug,
    status: data.status,
    createdBy: data.createdBy,
  });

  await project.save({
    session: dbSession,
  });

  return project;
};

export const findProjectsByOrganization = async (
  organizationId: Types.ObjectId,
  options: FindProjectsOptions = {},
): Promise<IProject[]> => {
  const limit = Math.min(
    Math.max(
      Math.trunc(options.limit ?? DEFAULT_PROJECT_LIST_LIMIT),
      1,
    ),
    MAX_PROJECT_LIST_LIMIT,
  );
  const skip = Math.max(Math.trunc(options.skip ?? 0), 0);

  return Project.find({
    organizationId,
  })
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .exec();
};

export const findProjectByIdAndOrganization = async (
  projectId: Types.ObjectId,
  organizationId: Types.ObjectId,
): Promise<IProject | null> => {
  return Project.findOne({
    _id: projectId,
    organizationId,
  }).exec();
};

export const updateProjectByIdAndOrganization = async (
  projectId: Types.ObjectId,
  organizationId: Types.ObjectId,
  data: UpdateProjectData,
): Promise<IProject | null> => {
  // Copy only the editable fields; _id, organizationId, createdBy and
  // createdAt can never be set through this function.
  const set: UpdateProjectData = {};

  if (data.name !== undefined) set.name = data.name;
  if (data.description !== undefined) {
    set.description = data.description;
  }
  if (data.slug !== undefined) set.slug = data.slug;
  if (data.status !== undefined) set.status = data.status;

  return Project.findOneAndUpdate(
    {
      _id: projectId,
      organizationId,
    },
    {
      $set: set,
    },
    {
      new: true,
      runValidators: true,
    },
  ).exec();
};

export const deleteProjectByIdAndOrganization = async (
  projectId: Types.ObjectId,
  organizationId: Types.ObjectId,
): Promise<boolean> => {
  const result = await Project.deleteOne({
    _id: projectId,
    organizationId,
  }).exec();

  return result.deletedCount === 1;
};
