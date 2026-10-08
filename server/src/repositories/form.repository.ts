import mongoose, { type ClientSession } from "mongoose";

import { Form, type IForm } from "../models/form.model.js";
import { isValidPublicId } from "../utils/public-id.util.js";

/*
 * Form queries (8.17.3).
 *
 * Forms are tenant-owned. organizationId is always an explicit argument
 * supplied by the caller (derived from the authenticated request context),
 * never read from a form input object. Every query for a specific form
 * matches BOTH _id (or slug) and organizationId, so a form belonging to
 * another organization simply does not match. Never look a form up by
 * _id or slug alone.
 *
 * Every query and document is built explicitly from typed arguments:
 * there is no generic find/update/delete that accepts a caller-supplied
 * filter, and query values are re-checked at runtime so an operator
 * object (for example { $ne: ... }) can never become a MongoDB operator.
 *
 * This layer does not verify that projectId belongs to the organization
 * (service layer) and does not pre-check slug uniqueness: the unique
 * { organizationId, slug } index is the source of truth, and a duplicate
 * key error (11000) bubbles up unchanged.
 */

export const DEFAULT_FORM_LIST_LIMIT = 20;
export const MAX_FORM_LIST_LIMIT = 100;

export type CreateFormData = Pick<
  IForm,
  "projectId" | "name" | "description" | "slug" | "status" | "createdBy"
>;

export type UpdateFormData = Partial<
  Pick<
    IForm,
    | "name"
    | "description"
    | "slug"
    | "status"
    | "projectId"
    | "draftSchema"
    | "currentDraftVersionId"
    | "publishedVersionId"
    | "updatedBy"
  >
>;

export interface FindFormsOptions {
  projectId?: mongoose.Types.ObjectId;
  limit?: number;
  skip?: number;
}

/*
 * Rebuilds an id from a real ObjectId (or a 24-char hex string). An
 * operator object or any other shape throws instead of reaching MongoDB.
 */
const safeObjectId = (value: unknown): mongoose.Types.ObjectId => {
  if (
    value instanceof mongoose.Types.ObjectId ||
    (typeof value === "string" && /^[a-f\d]{24}$/i.test(value))
  ) {
    return new mongoose.Types.ObjectId(value.toString());
  }

  throw new TypeError("Invalid ObjectId");
};

const safeString = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("Expected a string");
  }

  return value;
};

/* A publicId must be the exact generated shape before it reaches MongoDB
 * (these updates run without schema validators). */
const safePublicId = (value: unknown): string => {
  if (!isValidPublicId(value)) {
    throw new TypeError("Invalid publicId");
  }

  return value;
};

export const createForm = async (
  organizationId: mongoose.Types.ObjectId,
  data: CreateFormData,
  dbSession?: ClientSession,
): Promise<IForm> => {
  const form = new Form({
    organizationId: safeObjectId(organizationId),
    projectId: safeObjectId(data.projectId),
    name: data.name,
    description: data.description,
    slug: data.slug,
    status: data.status,
    createdBy: safeObjectId(data.createdBy),
  });

  await form.save({
    session: dbSession,
  });

  return form;
};

export const findFormsByOrganization = async (
  organizationId: mongoose.Types.ObjectId,
  options: FindFormsOptions = {},
): Promise<IForm[]> => {
  const limit = Math.min(
    Math.max(
      Math.trunc(options.limit ?? DEFAULT_FORM_LIST_LIMIT),
      1,
    ),
    MAX_FORM_LIST_LIMIT,
  );
  const skip = Math.max(Math.trunc(options.skip ?? 0), 0);

  return Form.find({
    organizationId: safeObjectId(organizationId),
    ...(options.projectId !== undefined
      ? { projectId: safeObjectId(options.projectId) }
      : {}),
  })
    // A draft can be large; it is only returned by the single-form reads.
    .select("-draftSchema")
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .exec();
};

export const findFormByIdAndOrganization = async (
  formId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
  dbSession?: ClientSession,
): Promise<IForm | null> => {
  return Form.findOne({
    _id: safeObjectId(formId),
    organizationId: safeObjectId(organizationId),
  })
    .session(dbSession ?? null)
    .exec();
};

/*
 * Publishing (8.17.13): marks the form published and points it at the new
 * version, but only if its publishedVersionId is still the value the
 * caller read (compare-and-set). Returns null when the form is gone or
 * another publish got there first. Never touches draftSchema.
 */
export const markFormPublished = async (
  formId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
  expectedPublishedVersionId: mongoose.Types.ObjectId | null,
  data: {
    publishedVersionId: mongoose.Types.ObjectId;
    updatedBy: mongoose.Types.ObjectId;
    /* Used only if the form has no publicId yet; an existing one is kept. */
    publicId: string;
  },
  dbSession?: ClientSession,
): Promise<IForm | null> => {
  return Form.findOneAndUpdate(
    {
      _id: safeObjectId(formId),
      organizationId: safeObjectId(organizationId),
      // null matches a form that was never published.
      publishedVersionId:
        expectedPublishedVersionId === null
          ? null
          : safeObjectId(expectedPublishedVersionId),
    },
    // Pipeline update so "keep the existing publicId, otherwise set the
    // new one" is a single atomic step: a form's public id never changes
    // once assigned, even under concurrent publishes.
    [
      {
        $set: {
          status: "PUBLISHED",
          publishedVersionId: safeObjectId(data.publishedVersionId),
          updatedBy: safeObjectId(data.updatedBy),
          publicId: {
            $ifNull: ["$publicId", { $literal: safePublicId(data.publicId) }],
          },
        },
      },
    ],
    { new: true, session: dbSession, updatePipeline: true },
  ).exec();
};

/*
 * Gives a published form that predates publicId its public identifier.
 * Atomic and idempotent: only a form without one is touched, so racing
 * callers cannot overwrite each other's value. Returns the form as it is
 * afterwards, or null when it does not exist in the organization.
 */
export const assignPublicIdIfMissing = async (
  formId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
  publicId: string,
): Promise<IForm | null> => {
  const scope = {
    _id: safeObjectId(formId),
    organizationId: safeObjectId(organizationId),
  };

  const assigned = await Form.findOneAndUpdate(
    { ...scope, publicId: { $exists: false } },
    { $set: { publicId: safePublicId(publicId) } },
    { new: true },
  ).exec();

  return assigned ?? Form.findOne(scope).exec();
};

/*
 * The ONLY form lookup without a tenant filter: a share link carries just
 * the random publicId. Callers must derive everything else (organization,
 * version) from the returned document and expose none of it. The shape is
 * checked first so nothing but a plain string reaches the query.
 */
export const findFormByPublicId = async (
  publicId: string,
): Promise<IForm | null> => {
  if (!isValidPublicId(publicId)) {
    return null;
  }

  return Form.findOne({ publicId }).select("-draftSchema").exec();
};

export const findFormBySlugAndOrganization = async (
  slug: string,
  organizationId: mongoose.Types.ObjectId,
): Promise<IForm | null> => {
  return Form.findOne({
    organizationId: safeObjectId(organizationId),
    slug: safeString(slug),
  }).exec();
};

export const updateFormByIdAndOrganization = async (
  formId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
  data: UpdateFormData,
): Promise<IForm | null> => {
  // Explicit allowlist: _id, organizationId, createdBy, createdAt,
  // updatedAt and any unknown or operator key are never copied.
  const set: UpdateFormData = {};

  if (data.name !== undefined) set.name = data.name;
  if (data.description !== undefined) {
    set.description = data.description;
  }
  if (data.slug !== undefined) set.slug = data.slug;
  if (data.status !== undefined) set.status = data.status;
  if (data.projectId !== undefined) {
    set.projectId = safeObjectId(data.projectId);
  }
  if (data.draftSchema !== undefined) {
    set.draftSchema = data.draftSchema;
  }
  if (data.currentDraftVersionId !== undefined) {
    set.currentDraftVersionId = safeObjectId(
      data.currentDraftVersionId,
    );
  }
  if (data.publishedVersionId !== undefined) {
    set.publishedVersionId = safeObjectId(data.publishedVersionId);
  }
  if (data.updatedBy !== undefined) {
    set.updatedBy = safeObjectId(data.updatedBy);
  }

  return Form.findOneAndUpdate(
    {
      _id: safeObjectId(formId),
      organizationId: safeObjectId(organizationId),
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

export const deleteFormByIdAndOrganization = async (
  formId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
): Promise<boolean> => {
  const result = await Form.deleteOne({
    _id: safeObjectId(formId),
    organizationId: safeObjectId(organizationId),
  }).exec();

  return result.deletedCount === 1;
};
