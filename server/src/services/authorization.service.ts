import mongoose from "mongoose";

import {
  isPermission,
  type Permission,
} from "../constants/permissions.js";

import { findOrganizationById } from "../repositories/organization.repository.js";
import { findRolesByIdsForOrganization } from "../repositories/role.repository.js";
import { findUserById } from "../repositories/user.repository.js";

import type {
  ActiveAccountContext,
  AuthContext,
} from "../types/auth.types.js";
import { AppError } from "../utils/errors.js";

/*
 * Loads the authenticated user and organization from the database and
 * verifies both are ACTIVE.
 *
 * A valid access token is not enough: the JWT is stateless, so the
 * account may have been suspended or deleted after it was issued.
 * This costs two parallel indexed lookups per protected request; there
 * is deliberately no cache, so a suspension takes effect immediately.
 *
 * 401: the user or organization does not exist, or the token's
 *      organization is not the user's organization.
 * 403: the account exists but is not active. The message does not say
 *      whether the user or the organization is the inactive one.
 */
export const loadActiveAccount = async (
  auth: AuthContext,
): Promise<ActiveAccountContext> => {
  const [user, organization] = await Promise.all([
    findUserById(new mongoose.Types.ObjectId(auth.userId)),
    findOrganizationById(
      new mongoose.Types.ObjectId(auth.organizationId),
    ),
  ]);

  if (
    !user ||
    !organization ||
    user.organizationId.toString() !== auth.organizationId
  ) {
    throw new AppError(
      401,
      "UNAUTHORIZED",
      "Authentication required",
    );
  }

  if (
    user.status !== "ACTIVE" ||
    organization.status !== "ACTIVE"
  ) {
    throw new AppError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      "Account is not active",
    );
  }

  return {
    userId: user._id.toString(),
    organizationId: organization._id.toString(),
    roleIds: user.roleIds.map((roleId) => roleId.toString()),
  };
};

/*
 * Resolves the user's effective permissions.
 *
 * Source of truth: the permissions stored on the Role documents that
 * (a) the user references and (b) belong to the authenticated
 * organization. No role-to-permission matrix lives in code: a role
 * that stores no permissions grants nothing (fail safe), and unknown
 * permission strings are ignored.
 */
export const resolvePermissions = async (
  account: ActiveAccountContext,
): Promise<ReadonlySet<Permission>> => {
  const roles = await findRolesByIdsForOrganization(
    account.roleIds.map(
      (roleId) => new mongoose.Types.ObjectId(roleId),
    ),
    new mongoose.Types.ObjectId(account.organizationId),
  );

  const granted = new Set<Permission>();

  for (const role of roles) {
    for (const permission of role.permissions) {
      if (isPermission(permission)) {
        granted.add(permission);
      }
    }
  }

  return granted;
};
