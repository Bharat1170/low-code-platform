import { type ClientSession } from "mongoose";

import {
  Role,
  type IRole,
} from "../models/role.model.js";

export const findRoleByOrganizationAndName = async (
  organizationId: IRole["organizationId"],
  name: IRole["name"],
): Promise<IRole | null> => {
  return Role.findOne({
    organizationId,
    name,
  }).exec();
};

export const createRole = async (
  data: Pick<
    IRole,
    "organizationId" | "name" | "description" | "permissions"
  >,
  session?: ClientSession,
): Promise<IRole> => {
  const [role] = await Role.create(
    [
      {
        organizationId: data.organizationId,
        name: data.name,
        description: data.description,
        permissions: data.permissions,
      },
    ],
    { session },
  );

  return role;
};

/*
 * Authorization lookup: only roles that BOTH are referenced by the user
 * AND belong to the authenticated organization are ever returned, so a
 * role id from another tenant can never contribute permissions.
 */
export const findRolesByIdsForOrganization = async (
  roleIds: IRole["_id"][],
  organizationId: IRole["organizationId"],
): Promise<IRole[]> => {
  if (roleIds.length === 0) {
    return [];
  }

  return Role.find({
    _id: { $in: roleIds },
    organizationId,
  }).exec();
};
