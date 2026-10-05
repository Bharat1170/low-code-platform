import mongoose from "mongoose";

import { env } from "../config/env.js";
import { AUDIT_ACTIONS } from "../constants/audit-actions.js";
import { AUTH_CONSTANTS } from "../constants/auth.constants.js";
import {
  OWNER_PERMISSIONS,
  ROLE_NAMES,
} from "../constants/roles.js";

import {
  createOrganization,
  findOrganizationById,
  findOrganizationBySlug,
} from "../repositories/organization.repository.js";

import {
  recordFailedLoginAttempt,
  clearFailedLoginAttempts,
} from "../repositories/login-security.repository.js";

import { getProgressiveLoginDelayMs } from "../utils/login-security.util.js";


import {
  createAuditLog,
  findLatestLoginAuditLog,
} from "../repositories/audit-log.repository.js";

import {
  createRole,
} from "../repositories/role.repository.js";

import {
  createUser,
  findUnverifiedUserByEmail,
  findUserByEmailForLogin,
  findUserById,
  markUserEmailAsVerified,
  updateUserLastLoginAt,
} from "../repositories/user.repository.js";

import {
  acquireVerificationResendCooldown,
  consumeVerificationToken,
  createVerificationResendCooldownKey,
  saveVerificationToken,
} from "../repositories/verification-token.repository.js";

import {
  revokeSession,
} from "../repositories/session.repository.js";

import type { AuthContext } from "../types/auth.types.js";

import type {
  LoginInput,
  RegisterInput,
  ResendVerificationInput,
} from "../validators/auth.validator.js";

import {
  generateSecureToken,
  hashToken,
} from "../utils/token.util.js";

import { AppError } from "../utils/errors.js";

import {
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDummyHash,
} from "../utils/password.util.js";

import { sendVerificationEmail } from "./email.service.js";

import { createLoginSession } from "./session.service.js";

const createOrganizationSlug = (
  organizationName: string,
): string => {
  const baseSlug = organizationName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return baseSlug || "organization";
};

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    organizationId: string;
  };
}

export interface LoginContext {
  ipAddress: string;
  userAgent: string;
}

export const registerUser = async (
  input: RegisterInput,
  context: LoginContext,
): Promise<{
  userId: string;
  organizationId: string;
  email: string;
}> => {
  const session = await mongoose.startSession();

  let userId = "";
  let organizationId = "";
  let email = "";
  let verificationToken = "";

  try {
    session.startTransaction();

    const normalizedEmail = input.email
      .trim()
      .toLowerCase();

    let slug = createOrganizationSlug(
      input.organizationName,
    );

    const existingOrganization =
      await findOrganizationBySlug(slug);

    if (existingOrganization) {
      slug = `${slug}-${Date.now()}`;
    }

    const organization = await createOrganization(
      {
        name: input.organizationName.trim(),
        slug,
      },
      session,
    );

    const passwordHash = await hashPassword(
      input.password,
    );

    const ownerRole = await createRole(
      {
        organizationId: organization._id,
        name: ROLE_NAMES.OWNER,
        description: "Organization owner",
        permissions: [...OWNER_PERMISSIONS],
      },
      session,
    );

    const user = await createUser(
      {
        organizationId: organization._id,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: normalizedEmail,
        passwordHash,
        roleIds: [ownerRole._id],
      },
      session,
    );

    // Audited inside the registration transaction: if this write
    // fails, the organization, role and user are rolled back too.
    // Identity and request context come from trusted server-side
    // data, and metadata deliberately holds no credentials or tokens.
    await createAuditLog(
      {
        organizationId: organization._id,
        userId: user._id,
        action: AUDIT_ACTIONS.USER_REGISTERED,
        resourceType: "USER",
        resourceId: user._id,
        metadata: {},
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      session,
    );

    verificationToken = generateSecureToken(
      AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_BYTES,
    );

    const verificationTokenHash =
      hashToken(verificationToken);

    await session.commitTransaction();

    userId = user._id.toString();
    organizationId = organization._id.toString();
    email = user.email;

    await saveVerificationToken(
      verificationTokenHash,
      userId,
      AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
    );
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }

    throw error;
  } finally {
    await session.endSession();
  }

  const verificationUrl = new URL(
    "/verify-email",
    env.CLIENT_URL,
  );

  verificationUrl.searchParams.set(
    "token",
    verificationToken,
  );

  await sendVerificationEmail(
    email,
    verificationUrl.toString(),
  );

  return {
    userId,
    organizationId,
    email,
  };
};

export const verifyLoginCredentials = async (
  input: LoginInput,
  context: LoginContext,
) => {
  const failLoginAttempt = async (): Promise<never> => {
    const failedAttemptCount =
      await recordFailedLoginAttempt(
        input.email,
        context.ipAddress,
        AUTH_CONSTANTS.LOGIN_FAILURE_TRACKING_TTL_SECONDS,
      );

    const delayMs = getProgressiveLoginDelayMs(
      failedAttemptCount,
    );

    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }

    // One error for both an unknown email and a wrong password.
    throw new AppError(
      401,
      "INVALID_CREDENTIALS",
      "Invalid email or password",
    );
  };

  const user = await findUserByEmailForLogin(
    input.email,
  );

  if (!user) {
    await verifyPasswordAgainstDummyHash(input.password);

    return failLoginAttempt();
  }

  const isPasswordValid = await verifyPassword(
    input.password,
    user.passwordHash,
  );

  if (!isPasswordValid) {
    return failLoginAttempt();
  }

  if (user.status !== "ACTIVE") {
    throw new AppError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      "Account is not active",
    );
  }

  const organization = await findOrganizationById(
    user.organizationId,
  );

  if (
    !organization ||
    organization.status !== "ACTIVE"
  ) {
    throw new AppError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      "Account is not active",
    );
  }

  await clearFailedLoginAttempts(
    input.email,
    context.ipAddress,
  );

  return user;
};

export const loginUser = async (
  input: LoginInput,
  context: LoginContext,
): Promise<LoginResult> => {
  const user = await verifyLoginCredentials(
    input,
    context,
  );

  const session = await createLoginSession(
    user._id.toString(),
    user.organizationId.toString(),
  );

  const previousLogin =
  await findLatestLoginAuditLog(user._id);

const suspiciousLogin =
  previousLogin !== null &&
  previousLogin.ipAddress !== context.ipAddress;


  try {
    await updateUserLastLoginAt(user._id);

    await createAuditLog({
      organizationId: user.organizationId,
      userId: user._id,
      action: "USER_LOGIN",
      resourceType: "USER",
      resourceId: user._id,
   metadata: {
        sessionId: session.sessionId,
        suspiciousLogin,
        previousLoginIpAddress:
            previousLogin?.ipAddress ?? null,
        },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  } catch (error) {
    await revokeSession(session.sessionId);
    throw error;
  }

  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    user: {
      id: user._id.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      organizationId: user.organizationId.toString(),
    },
  };
};

export const verifyUserEmail = async (
  token: string,
): Promise<void> => {
  const tokenHash = hashToken(token);

  const userId =
    await consumeVerificationToken(tokenHash);

  if (!userId) {
    throw new AppError(
      400,
      "INVALID_OR_EXPIRED_TOKEN",
      "Invalid or expired verification token",
    );
  }

  const updated =
    await markUserEmailAsVerified(userId);

  if (!updated) {
    // Same response as an unknown token: do not reveal the account state.
    throw new AppError(
      400,
      "INVALID_OR_EXPIRED_TOKEN",
      "Invalid or expired verification token",
    );
  }
};

export const resendVerificationEmail = async (
  input: ResendVerificationInput,
): Promise<void> => {
  const normalizedEmail = input.email
    .trim()
    .toLowerCase();

  const cooldownKey =
    createVerificationResendCooldownKey(
      input.organizationId,
      normalizedEmail,
    );

  const cooldownAcquired =
    await acquireVerificationResendCooldown(
      cooldownKey,
      AUTH_CONSTANTS.RESEND_VERIFICATION_COOLDOWN_SECONDS,
    );

  if (!cooldownAcquired) {
    return;
  }

  const user = await findUnverifiedUserByEmail(
    new mongoose.Types.ObjectId(
      input.organizationId,
    ),
    normalizedEmail,
  );

  // Do not reveal whether the account exists.
  if (!user) {
    return;
  }

  const verificationToken =
    generateSecureToken(
      AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_BYTES,
    );

  const verificationTokenHash =
    hashToken(verificationToken);

  await saveVerificationToken(
    verificationTokenHash,
    user._id.toString(),
    AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
  );

  const verificationUrl = new URL(
    "/verify-email",
    env.CLIENT_URL,
  );

  verificationUrl.searchParams.set(
    "token",
    verificationToken,
  );

  await sendVerificationEmail(
    user.email,
    verificationUrl.toString(),
  );
};
export interface CurrentUserResult {
  user: LoginResult["user"];
  organization: { id: string; name: string };
}

/*
 * Profile of the authenticated user, used by clients to restore the
 * signed-in state after a token refresh. Identity comes only from the
 * verified access token; the user must still be active and belong to
 * that organization.
 */
export const getCurrentUser = async (
  auth: AuthContext,
): Promise<CurrentUserResult> => {
  const unauthorized = new AppError(
    401,
    "UNAUTHORIZED",
    "Authentication required",
  );

  if (
    !mongoose.isValidObjectId(auth.userId) ||
    !mongoose.isValidObjectId(auth.organizationId)
  ) {
    throw unauthorized;
  }

  const user = await findUserById(
    new mongoose.Types.ObjectId(auth.userId),
  );

  if (
    !user ||
    user.status !== "ACTIVE" ||
    user.organizationId.toString() !== auth.organizationId
  ) {
    throw unauthorized;
  }

  const organization = await findOrganizationById(
    user.organizationId,
  );

  if (!organization || organization.status !== "ACTIVE") {
    throw unauthorized;
  }

  return {
    user: {
      id: user._id.toString(),
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      organizationId: user.organizationId.toString(),
    },
    organization: {
      id: organization._id.toString(),
      name: organization.name,
    },
  };
};
