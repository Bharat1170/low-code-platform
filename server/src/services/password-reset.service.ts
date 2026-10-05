import mongoose from "mongoose";

import { env } from "../config/env.js";
import { AUDIT_ACTIONS } from "../constants/audit-actions.js";
import { AUTH_CONSTANTS } from "../constants/auth.constants.js";

import { createAuditLog } from "../repositories/audit-log.repository.js";
import { findOrganizationById } from "../repositories/organization.repository.js";
import {
  acquirePasswordResetCooldown,
  consumePasswordResetToken,
  createPasswordResetCooldownKey,
  deletePasswordResetToken,
  peekPasswordResetToken,
  savePasswordResetToken,
} from "../repositories/password-reset-token.repository.js";
import { revokeAllActiveSessionsForUser } from "../repositories/session.repository.js";
import {
  findActiveVerifiedUserByEmail,
  findUserByIdWithPasswordHash,
  updateUserPassword,
} from "../repositories/user.repository.js";

import { AppError } from "../utils/errors.js";
import {
  hashPassword,
  verifyPassword,
} from "../utils/password.util.js";
import {
  generateSecureToken,
  hashToken,
} from "../utils/token.util.js";

import type {
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../validators/auth.validator.js";

import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "./email.service.js";

export interface PasswordResetContext {
  ipAddress: string;
  userAgent: string;
}

const RESET_TOKEN_TTL_MINUTES =
  AUTH_CONSTANTS.PASSWORD_RESET_TOKEN_TTL_SECONDS / 60;

const invalidOrExpiredToken = (): AppError => {
  return new AppError(
    400,
    "INVALID_OR_EXPIRED_TOKEN",
    "Invalid or expired password reset token",
  );
};

/*
 * Logs only the error class, never the error object: failures here can
 * come from Redis or SMTP and must never echo tokens or addresses.
 */
const logSafely = (message: string, error: unknown): void => {
  console.error(
    message,
    error instanceof Error ? error.name : "unknown error",
  );
};

/*
 * Forgot password.
 *
 * Always resolves normally: callers return the same generic response
 * whether the account exists, is ineligible, or something failed, so
 * the endpoint never reveals account existence.
 */
export const requestPasswordReset = async (
  input: ForgotPasswordInput,
  context: PasswordResetContext,
): Promise<void> => {
  let tokenHash: string | null = null;
  let userId: string | null = null;

  try {
    const email = input.email.trim().toLowerCase();

    // Applies to unknown emails too, so the cooldown is not an oracle.
    const cooldownAcquired = await acquirePasswordResetCooldown(
      createPasswordResetCooldownKey(email),
      AUTH_CONSTANTS.PASSWORD_RESET_COOLDOWN_SECONDS,
    );

    if (!cooldownAcquired) {
      return;
    }

    const user = await findActiveVerifiedUserByEmail(email);

    if (!user) {
      return;
    }

    const organization = await findOrganizationById(
      user.organizationId,
    );

    if (!organization || organization.status !== "ACTIVE") {
      return;
    }

    const rawToken = generateSecureToken(
      AUTH_CONSTANTS.PASSWORD_RESET_TOKEN_BYTES,
    );

    tokenHash = hashToken(rawToken);
    userId = user._id.toString();

    // No email is sent unless the token was stored.
    await savePasswordResetToken(
      tokenHash,
      {
        userId,
        organizationId: user.organizationId.toString(),
      },
      AUTH_CONSTANTS.PASSWORD_RESET_TOKEN_TTL_SECONDS,
    );

    await createAuditLog({
      organizationId: user.organizationId,
      userId: user._id,
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      resourceType: "USER",
      resourceId: user._id,
      metadata: {},
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    const resetUrl = new URL("/reset-password", env.CLIENT_URL);
    resetUrl.searchParams.set("token", rawToken);

    await sendPasswordResetEmail(
      user.email,
      resetUrl.toString(),
      RESET_TOKEN_TTL_MINUTES,
    );
  } catch (error) {
    logSafely("❌ Password reset request failed:", error);

    // A token whose email could not be sent is unusable: remove it.
    if (tokenHash && userId) {
      try {
        await deletePasswordResetToken(tokenHash, userId);
      } catch (cleanupError) {
        logSafely(
          "❌ Password reset token cleanup failed:",
          cleanupError,
        );
      }
    }
  }
};

/*
 * Reset password.
 *
 * Order matters:
 *  1. peek the token (does not consume it)
 *  2. reject missing/inactive users, burning the token
 *  3. reject a password equal to the current one (token stays usable)
 *  4. atomically consume the token (only one caller can win)
 *  5. update password + revoke all sessions + audit in ONE transaction
 */
export const resetPassword = async (
  input: ResetPasswordInput,
  context: PasswordResetContext,
): Promise<void> => {
  const tokenHash = hashToken(input.token);

  let payload;

  try {
    payload = await peekPasswordResetToken(tokenHash);
  } catch (error) {
    logSafely("❌ Password reset token lookup failed:", error);

    throw new AppError(
      503,
      "SERVICE_UNAVAILABLE",
      "Service temporarily unavailable",
    );
  }

  if (!payload) {
    throw invalidOrExpiredToken();
  }

  const user = await findUserByIdWithPasswordHash(
    new mongoose.Types.ObjectId(payload.userId),
  );

  const organization = user
    ? await findOrganizationById(user.organizationId)
    : null;

  const eligible =
    user !== null &&
    user.status === "ACTIVE" &&
    user.organizationId.toString() === payload.organizationId &&
    organization !== null &&
    organization.status === "ACTIVE";

  if (!user || !eligible) {
    // Burn the token so it cannot be retried.
    await consumePasswordResetToken(tokenHash);

    throw invalidOrExpiredToken();
  }

  if (await verifyPassword(input.newPassword, user.passwordHash)) {
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

  const consumed = await consumePasswordResetToken(tokenHash);

  if (!consumed || consumed.userId !== payload.userId) {
    throw invalidOrExpiredToken();
  }

  const userId = user._id;
  const organizationId = user.organizationId;

  const dbSession = await mongoose.startSession();

  try {
    await dbSession.withTransaction(async () => {
      const updated = await updateUserPassword(
        userId,
        newPasswordHash,
        dbSession,
      );

      if (!updated) {
        throw invalidOrExpiredToken();
      }

      const revokedSessionCount =
        await revokeAllActiveSessionsForUser(
          userId,
          organizationId,
          dbSession,
        );

      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
          resourceType: "USER",
          resourceId: userId,
          metadata: { revokedSessionCount },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );
    });
  } finally {
    await dbSession.endSession();
  }

  try {
    await sendPasswordChangedEmail(user.email);
  } catch (error) {
    logSafely("❌ Password changed email failed:", error);
  }
};
