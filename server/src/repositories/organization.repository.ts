import { type ClientSession } from "mongoose";

import {
  Organization,
  type IOrganization,
} from "../models/organization.model.js";

export const findOrganizationBySlug = async (
  slug: string,
): Promise<IOrganization | null> => {
  return Organization.findOne({ slug }).exec();
};

export const createOrganization = async (
  data: Pick<IOrganization, "name" | "slug">,
  session?: ClientSession,
): Promise<IOrganization> => {
  const [organization] = await Organization.create(
    [
      {
        name: data.name,
        slug: data.slug,
      },
    ],
    { session },
  );

  return organization;
};

export const findOrganizationById = async (
  organizationId: IOrganization["_id"],
  dbSession?: ClientSession,
): Promise<IOrganization | null> => {
  const query = Organization.findById(
    organizationId,
  );

  if (dbSession) {
    query.session(dbSession);
  }

  return query.exec();
};