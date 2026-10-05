import mongoose from "mongoose";

import { AUDIT_ACTIONS } from "../constants/audit-actions.js";

import { createAuditLog } from "../repositories/audit-log.repository.js";
import { findOrganizationById } from "../repositories/organization.repository.js";
import { revokeAllActiveSessionsForUser } from "../repositories/session.repository.js";
import {
  findUserByIdWithPasswordHash,
  updateUserPassword,
} from "../repositories/user.repository.js";

import type { AuthContext } from "../types/auth.types.js";
import { AppError } from "../utils/errors.js";
import {
  hashPassword,
  verifyPassword,
} from "../utils/password.util.js";
import type { ChangePasswordInput } from "../validators/auth.validator.js";

export interface ChangePasswordContext {
  ipAddress: string;
  userAgent: string;
}

/*
 * Authenticated password change.
 *
 * The user is identified only by the verified JWT (auth.userId); the
 * organization used for the audit record is read from the database
 * record, not from the request.
 *
 * Password update, revocation of ALL of the user's active sessions and
 * the audit record happen in one transaction. Already-issued access
 * tokens stay valid until they expire (stateless JWTs).
 */
export const changeUserPassword = async (
  auth: AuthContext,
  input: ChangePasswordInput,
  context: ChangePasswordContext,
): Promise<void> => {
  const user = await findUserByIdWithPasswordHash(
    new mongoose.Types.ObjectId(auth.userId),
  );

  // The token's organization must match the stored user's organization.
  if (
    !user ||
    user.organizationId.toString() !== auth.organizationId
  ) {
    throw new AppError(
      401,
      "UNAUTHORIZED",
      "Authentication required",
    );
  }

  const organization = await findOrganizationById(
    user.organizationId,
  );

  if (
    user.status !== "ACTIVE" ||
    !organization ||
    organization.status !== "ACTIVE"
  ) {
    throw new AppError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      "Account is not active",
    );
  }

  const currentPasswordHash = user.passwordHash;

  const currentPasswordValid = await verifyPassword(
    input.currentPassword,
    currentPasswordHash,
  );

  if (!currentPasswordValid) {
    // 400 rather than 401 so clients do not treat it as an expired session.
    throw new AppError(
      400,
      "INVALID_CURRENT_PASSWORD",
      "Current password is incorrect",
      {
        currentPassword: "Current password is incorrect",
      },
    );
  }

  const sameAsCurrent = await verifyPassword(
    input.newPassword,
    currentPasswordHash,
  );

  if (sameAsCurrent) {
    throw new AppError(
      400,
      "PASSWORD_REUSE",
      "New password must be different from the current password",
      {
        newPassword:
          "New password must be different from the current password",
      },
    );
  }

  const newPasswordHash = await hashPassword(input.newPassword);

  const userId = user._id;
  const organizationId = user.organizationId;

  const dbSession = await mongoose.startSession();

  try {
    await dbSession.withTransaction(async () => {
      const updated = await updateUserPassword(
        userId,
        newPasswordHash,
        dbSession,
        currentPasswordHash,
      );

      // Zero matches means the password (or status) changed after we
      // read it, for example a concurrent change-password request.
      if (!updated) {
        throw new AppError(
          409,
          "PASSWORD_CHANGE_CONFLICT",
          "Password was changed by another request. Please sign in again.",
        );
      }

      await revokeAllActiveSessionsForUser(
        userId,
        organizationId,
        dbSession,
      );

      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.PASSWORD_CHANGED,
          resourceType: "USER",
          resourceId: userId,
          metadata: {},
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );
    });
  } finally {
    await dbSession.endSession();
  }
};
