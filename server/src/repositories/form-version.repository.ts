import mongoose, { type ClientSession } from "mongoose";

import {
  FormVersion,
  type IFormVersion,
} from "../models/form-version.model.js";

/*
 * Form version queries (8.17.13).
 *
 * Only create and read operations exist: published versions are
 * immutable. Every query includes organizationId (and formId) so a
 * version of another tenant never matches.
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

export interface CreateFormVersionData {
  formId: mongoose.Types.ObjectId;
  version: number;
  schemaSnapshot: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdBy: mongoose.Types.ObjectId;
  publishedBy: mongoose.Types.ObjectId;
  publishedAt: Date;
}

export const createFormVersion = async (
  organizationId: mongoose.Types.ObjectId,
  data: CreateFormVersionData,
  dbSession?: ClientSession,
): Promise<IFormVersion> => {
  const version = new FormVersion({
    organizationId: safeObjectId(organizationId),
    formId: safeObjectId(data.formId),
    version: data.version,
    status: "PUBLISHED",
    schemaSnapshot: data.schemaSnapshot,
    settings: data.settings,
    createdBy: safeObjectId(data.createdBy),
    publishedBy: safeObjectId(data.publishedBy),
    publishedAt: data.publishedAt,
  });

  await version.save({ session: dbSession });

  return version;
};

/* Highest version number of a form, or 0 when it was never published. */
export const findLatestVersionNumber = async (
  organizationId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  dbSession?: ClientSession,
): Promise<number> => {
  const latest = await FormVersion.findOne({
    organizationId: safeObjectId(organizationId),
    formId: safeObjectId(formId),
  })
    .sort({ version: -1 })
    .select("version")
    .session(dbSession ?? null)
    .exec();

  return latest?.version ?? 0;
};

export const findFormVersionById = async (
  versionId: mongoose.Types.ObjectId,
  formId: mongoose.Types.ObjectId,
  organizationId: mongoose.Types.ObjectId,
  dbSession?: ClientSession,
): Promise<IFormVersion | null> => {
  return FormVersion.findOne({
    _id: safeObjectId(versionId),
    formId: safeObjectId(formId),
    organizationId: safeObjectId(organizationId),
  })
    .session(dbSession ?? null)
    .exec();
};
