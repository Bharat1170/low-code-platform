import mongoose, { type ClientSession } from "mongoose";

import {
  FormSubmission,
  type IFormSubmission,
} from "../models/form-submission.model.js";

/*
 * Form submission queries (8.17.15). Only create exists for now; every
 * future query must include organizationId. Authorization is decided by
 * the service, not here.
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

export interface CreateFormSubmissionData {
  formId: mongoose.Types.ObjectId;
  formVersionId: mongoose.Types.ObjectId;
  version: number;
  data: Record<string, string | boolean>;
  submittedBy: mongoose.Types.ObjectId;
  submittedAt: Date;
}

export interface SubmissionListFilter {
  /* Exact form version number. */
  version?: number;
  /* Inclusive lower bound. */
  submittedFrom?: Date;
  /* Exclusive upper bound. */
  submittedBefore?: Date;
}

export interface SubmissionListOptions {
  filter: SubmissionListFilter;
  order: "asc" | "desc";
  skip: number;
  limit: number;
}

/*
 * The query is always built here from typed values and always starts with
 * organizationId and formId; no client object is ever passed through.
 */
const buildListQuery = (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  filter: SubmissionListFilter,
): mongoose.QueryFilter<IFormSubmission> => {
  const query: mongoose.QueryFilter<IFormSubmission> = {
    organizationId: safeObjectId(organizationId),
    formId: safeObjectId(formId),
  };

  if (filter.version !== undefined) {
    query.version = filter.version;
  }

  if (filter.submittedFrom || filter.submittedBefore) {
    query.submittedAt = {
      ...(filter.submittedFrom ? { $gte: filter.submittedFrom } : {}),
      ...(filter.submittedBefore ? { $lt: filter.submittedBefore } : {}),
    };
  }

  return query;
};

/* Page of submissions WITHOUT their data (the list never needs it). */
export const listSubmissions = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  options: SubmissionListOptions,
) => {
  const direction = options.order === "asc" ? 1 : -1;

  return FormSubmission.find(
    buildListQuery(organizationId, formId, options.filter),
  )
    .select("formId formVersionId version submittedBy submittedAt")
    // _id breaks ties so pages are stable.
    .sort({ submittedAt: direction, _id: direction })
    .skip(options.skip)
    .limit(options.limit)
    .lean()
    .exec();
};

export const countSubmissions = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  filter: SubmissionListFilter,
): Promise<number> => {
  return FormSubmission.countDocuments(
    buildListQuery(organizationId, formId, filter),
  ).exec();
};

/* Never by id alone: the organization and the form must match too. */
export const findSubmissionById = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
): Promise<IFormSubmission | null> => {
  return FormSubmission.findOne({
    _id: safeObjectId(submissionId),
    organizationId: safeObjectId(organizationId),
    formId: safeObjectId(formId),
  }).exec();
};

/*
 * Hard delete, scoped by organization AND form like every other query.
 * Returns the deleted document (so the caller can audit it), or null when
 * nothing matched.
 */
export const deleteSubmissionById = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  submissionId: mongoose.Types.ObjectId,
  dbSession?: ClientSession,
): Promise<IFormSubmission | null> => {
  return FormSubmission.findOneAndDelete(
    {
      _id: safeObjectId(submissionId),
      organizationId: safeObjectId(organizationId),
      formId: safeObjectId(formId),
    },
    { session: dbSession },
  ).exec();
};

export const createFormSubmission = async (
  organizationId: mongoose.Types.ObjectId,
  input: CreateFormSubmissionData,
  dbSession?: ClientSession,
): Promise<IFormSubmission> => {
  const submission = new FormSubmission({
    organizationId: safeObjectId(organizationId),
    formId: safeObjectId(input.formId),
    formVersionId: safeObjectId(input.formVersionId),
    version: input.version,
    data: input.data,
    submittedBy: safeObjectId(input.submittedBy),
    submittedAt: input.submittedAt,
  });

  await submission.save({ session: dbSession });

  return submission;
};
