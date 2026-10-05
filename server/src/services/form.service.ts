import mongoose from "mongoose";

import {
  createForm as createFormRecord,
  deleteFormByIdAndOrganization,
  findFormByIdAndOrganization,
  findFormBySlugAndOrganization,
  findFormsByOrganization,
  updateFormByIdAndOrganization,
  type UpdateFormData,
} from "../repositories/form.repository.js";

import type { IForm } from "../models/form.model.js";

import { getProject } from "./project.service.js";

import type { AuthContext } from "../types/auth.types.js";

import type {
  CreateFormInput,
  UpdateFormInput,
} from "../validators/form.validator.js";

import { invalidatePublishedFormCache } from "../repositories/published-form-cache.repository.js";

import { AppError } from "../utils/errors.js";

/*
 * Form service (8.17.4).
 *
 * Tenant scope and creator identity come only from the authenticated
 * AuthContext, never from the request payload. The validated inputs
 * contain editable fields only (the validators are strict).
 *
 * The repository does not check that projectId belongs to the
 * organization; this service does, through the tenant-scoped project
 * lookup. A project that is missing or owned by another organization
 * produces the same PROJECT_NOT_FOUND error.
 *
 * Slug uniqueness is enforced solely by the unique
 * { organizationId, slug } index. A duplicate-key error from MongoDB is
 * deliberately not caught here; the error-handling layer translates it.
 *
 * A missing form and a form owned by another organization produce the
 * same FORM_NOT_FOUND error, so IDs of other tenants are never revealed.
 */

export interface ListFormsOptions {
  projectId?: string;
  limit?: number;
  skip?: number;
}

/*
 * Validated client fields plus the version pointers, which are only ever
 * set by trusted server-side code (future versioning/publishing), never
 * by the strict update schema.
 */
export type UpdateFormServiceInput = UpdateFormInput & {
  currentDraftVersionId?: mongoose.Types.ObjectId;
  publishedVersionId?: mongoose.Types.ObjectId;
};

/*
 * The published-form cache holds the form's name and serves only
 * non-archived forms, so metadata changes and deletes drop the entry.
 * Best effort: the entry also expires on its own.
 */
const dropPublishedCache = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
): Promise<void> => {
  try {
    await invalidatePublishedFormCache(organizationId, formId);
  } catch (error) {
    console.error(
      "❌ Published-form cache invalidation failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
};

const formNotFound = (): AppError => {
  return new AppError(404, "FORM_NOT_FOUND", "Form not found");
};

const toOrganizationId = (
  auth: AuthContext,
): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(auth.organizationId);
};

/*
 * Throws PROJECT_NOT_FOUND unless the project exists in the
 * authenticated organization.
 */
const assertProjectInOrganization = async (
  auth: AuthContext,
  projectId: string,
): Promise<mongoose.Types.ObjectId> => {
  const project = await getProject(auth, projectId);

  return project._id as mongoose.Types.ObjectId;
};

export const createForm = async (
  auth: AuthContext,
  input: CreateFormInput,
): Promise<IForm> => {
  const projectId = await assertProjectInOrganization(
    auth,
    input.projectId,
  );

  return createFormRecord(toOrganizationId(auth), {
    projectId,
    name: input.name,
    description: input.description ?? "",
    slug: input.slug,
    status: input.status,
    createdBy: new mongoose.Types.ObjectId(auth.userId),
  });
};

export const listForms = async (
  auth: AuthContext,
  options: ListFormsOptions = {},
): Promise<IForm[]> => {
  const projectId =
    options.projectId !== undefined
      ? await assertProjectInOrganization(auth, options.projectId)
      : undefined;

  return findFormsByOrganization(toOrganizationId(auth), {
    projectId,
    limit: options.limit,
    skip: options.skip,
  });
};

export const getFormById = async (
  auth: AuthContext,
  formId: string,
): Promise<IForm> => {
  const form = await findFormByIdAndOrganization(
    new mongoose.Types.ObjectId(formId),
    toOrganizationId(auth),
  );

  if (!form) {
    throw formNotFound();
  }

  return form;
};

export const getFormBySlug = async (
  auth: AuthContext,
  slug: string,
): Promise<IForm> => {
  const form = await findFormBySlugAndOrganization(
    slug,
    toOrganizationId(auth),
  );

  if (!form) {
    throw formNotFound();
  }

  return form;
};

export const updateForm = async (
  auth: AuthContext,
  formId: string,
  input: UpdateFormServiceInput,
): Promise<IForm> => {
  const organizationId = toOrganizationId(auth);
  const id = new mongoose.Types.ObjectId(formId);

  const existing = await findFormByIdAndOrganization(id, organizationId);

  if (!existing) {
    throw formNotFound();
  }

  // PUBLISHED is only reachable through the publish workflow, which
  // validates the draft, creates the immutable version, audits and
  // invalidates the cache. Never convert or ignore it silently.
  if (input.status === "PUBLISHED") {
    throw new AppError(
      400,
      "FORM_PUBLISH_REQUIRED",
      "A form can only be published with POST /api/forms/:id/publish",
    );
  }

  // Only a project change needs an ownership check.
  const projectId =
    input.projectId !== undefined
      ? await assertProjectInOrganization(auth, input.projectId)
      : undefined;

  const data: UpdateFormData = {
    updatedBy: new mongoose.Types.ObjectId(auth.userId),
  };

  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) {
    data.description = input.description;
  }
  if (input.slug !== undefined) data.slug = input.slug;
  if (input.status !== undefined) data.status = input.status;
  if (projectId !== undefined) data.projectId = projectId;
  if (input.draftSchema !== undefined) {
    data.draftSchema = input.draftSchema;
  }
  if (input.currentDraftVersionId !== undefined) {
    data.currentDraftVersionId = input.currentDraftVersionId;
  }
  if (input.publishedVersionId !== undefined) {
    data.publishedVersionId = input.publishedVersionId;
  }

  const form = await updateFormByIdAndOrganization(
    id,
    organizationId,
    data,
  );

  if (!form) {
    throw formNotFound();
  }

  // Autosaves (draftSchema only) never touch the published cache.
  if (input.draftSchema === undefined) {
    await dropPublishedCache(organizationId, id);
  }

  return form;
};

export const deleteForm = async (
  auth: AuthContext,
  formId: string,
): Promise<void> => {
  const organizationId = toOrganizationId(auth);
  const id = new mongoose.Types.ObjectId(formId);

  const existing = await findFormByIdAndOrganization(id, organizationId);

  if (!existing) {
    throw formNotFound();
  }

  const deleted = await deleteFormByIdAndOrganization(id, organizationId);

  if (!deleted) {
    throw formNotFound();
  }

  await dropPublishedCache(organizationId, id);
};
