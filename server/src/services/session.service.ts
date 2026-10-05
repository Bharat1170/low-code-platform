import mongoose from "mongoose";

import { env } from "../config/env.js";

import { createSession } from "../repositories/session.repository.js";

import {
  generateRefreshToken,
  generateSecureToken,
  hashToken,
} from "../utils/token.util.js";

import {
  findActiveSessionsForUser,
  findSessionByRefreshTokenHash,
  revokeActiveSessionForUser,
  revokeAllActiveSessionsForUser,
  revokeSession,
  revokeTokenFamily,
  rotateSession,
} from "../repositories/session.repository.js";

import { AUDIT_ACTIONS } from "../constants/audit-actions.js";

import type { AuthContext } from "../types/auth.types.js";

import { AppError } from "../utils/errors.js";


import {
  findOrganizationById,
} from "../repositories/organization.repository.js";

import {
  findUserById,
} from "../repositories/user.repository.js";

import { createAuditLog } from "../repositories/audit-log.repository.js";


import { generateAccessToken } from "../utils/jwt.util.js";

import { parseDurationToMilliseconds } from "../utils/duration.util.js";

export interface CreateLoginSessionResult {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface RefreshLoginSessionResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  sessionId: string;
}

export interface LogoutContext {
  ipAddress: string;
  userAgent: string;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

export interface RevokeSessionResult {
  revokedCurrentSession: boolean;
}

export interface RevokeAllSessionsResult {
  revokedCount: number;
}

/*
 * Lists the authenticated user's active sessions.
 * Only safe fields are returned. The current session is identified
 * from the verified access token's sessionId.
 */
export const listUserSessions = async (
  auth: AuthContext,
): Promise<SessionSummary[]> => {
  const sessions = await findActiveSessionsForUser(
    new mongoose.Types.ObjectId(auth.userId),
    new mongoose.Types.ObjectId(auth.organizationId),
  );

  return sessions.map((session) => ({
    id: session._id.toString(),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    current: session._id.toString() === auth.sessionId,
  }));
};

/*
 * Revokes one of the authenticated user's active sessions and writes
 * the audit record in the same transaction.
 *
 * A session that does not exist, belongs to someone else, is already
 * revoked or is expired all produce the same SESSION_NOT_FOUND error,
 * so the response never reveals whether the ID exists.
 */
export const revokeUserSession = async (
  auth: AuthContext,
  sessionId: string,
  context: LogoutContext,
): Promise<RevokeSessionResult> => {
  const userId = new mongoose.Types.ObjectId(auth.userId);
  const organizationId = new mongoose.Types.ObjectId(
    auth.organizationId,
  );
  const targetSessionId = new mongoose.Types.ObjectId(
    sessionId,
  );

  const revokedCurrentSession =
    targetSessionId.toString() === auth.sessionId;

  const dbSession = await mongoose.startSession();

  try {
    await dbSession.withTransaction(async () => {
      const revoked = await revokeActiveSessionForUser(
        targetSessionId,
        userId,
        organizationId,
        dbSession,
      );

      if (!revoked) {
        throw new AppError(
          404,
          "SESSION_NOT_FOUND",
          "Session not found",
        );
      }

      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.SESSION_REVOKED,
          resourceType: "SESSION",
          resourceId: targetSessionId,
          metadata: {
            revokedSessionId: targetSessionId.toString(),
            revokedCurrentSession,
          },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );
    });
  } finally {
    await dbSession.endSession();
  }

  return { revokedCurrentSession };
};

/*
 * Revokes every active session of the authenticated user within the
 * authenticated organization. The audit record is written in the same
 * transaction, and only when at least one session was revoked.
 */
export const revokeAllUserSessions = async (
  auth: AuthContext,
  context: LogoutContext,
): Promise<RevokeAllSessionsResult> => {
  const userId = new mongoose.Types.ObjectId(auth.userId);
  const organizationId = new mongoose.Types.ObjectId(
    auth.organizationId,
  );

  const dbSession = await mongoose.startSession();

  let revokedCount = 0;

  try {
    await dbSession.withTransaction(async () => {
      revokedCount = await revokeAllActiveSessionsForUser(
        userId,
        organizationId,
        dbSession,
      );

      if (revokedCount === 0) {
        return;
      }

      await createAuditLog(
        {
          organizationId,
          userId,
          action: AUDIT_ACTIONS.SESSIONS_REVOKED_ALL,
          resourceType: "SESSION",
          resourceId: null,
          metadata: {
            revokedCount,
          },
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
        },
        dbSession,
      );
    });
  } finally {
    await dbSession.endSession();
  }

  return { revokedCount };
};

export const logoutSession = async (
  refreshToken: string,
  context: LogoutContext,
): Promise<void> => {
  if (!refreshToken) {
    return;
  }

  const refreshTokenHash = hashToken(
    refreshToken,
  );

  const currentSession =
    await findSessionByRefreshTokenHash(
      refreshTokenHash,
    );

  // Logout is intentionally idempotent.
  // If the token is invalid or the session no longer exists,
  // the client can still safely clear its cookie.
  if (!currentSession) {
    return;
  }

  // The session has already been logged out.
  if (currentSession.revokedAt) {
    return;
  }

  const revoked = await revokeSession(
    currentSession._id.toString(),
  );

  if (!revoked) {
    return;
  }

  await createAuditLog({
    organizationId: currentSession.organizationId,
    userId: currentSession.userId,
    action: "USER_LOGOUT",
    resourceType: "SESSION",
    resourceId: currentSession._id,
    metadata: {},
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });
};

export const createLoginSession = async (
  userId: string,
  organizationId: string,
): Promise<CreateLoginSessionResult> => {
  const refreshToken = generateRefreshToken();

  const refreshTokenHash = hashToken(refreshToken);

  const tokenFamilyId = generateSecureToken(32);

  const refreshTokenTtlMilliseconds =
    parseDurationToMilliseconds(
      env.JWT_REFRESH_EXPIRES_IN,
    );

  const expiresAt = new Date(
    Date.now() + refreshTokenTtlMilliseconds,
  );

  const session = await createSession({
    userId: new mongoose.Types.ObjectId(userId),
    organizationId: new mongoose.Types.ObjectId(organizationId),
    tokenFamilyId,
    refreshTokenHash,
    expiresAt,
  });

  const accessToken = generateAccessToken({
    sub: userId,
    organizationId,
    sessionId: session._id.toString(),
  });

  return {
    sessionId: session._id.toString(),
    accessToken,
    refreshToken,
    expiresAt,
  };
};

export class RefreshTokenReuseError extends Error {
  public readonly tokenFamilyId: string;

  constructor(tokenFamilyId: string) {
    super("Refresh token reuse detected");
    this.name = "RefreshTokenReuseError";
    this.tokenFamilyId = tokenFamilyId;
  }
}

/*
 * Every refresh-token failure (unknown, expired, reused) returns the
 * same generic 401, so a caller cannot tell why a token was refused.
 */
const invalidRefreshToken = (): AppError => {
  return new AppError(
    401,
    "INVALID_REFRESH_TOKEN",
    "Invalid or expired refresh token",
  );
};

export const refreshLoginSession = async (
  refreshToken: string,
): Promise<RefreshLoginSessionResult> => {
  if (!refreshToken) {
    throw invalidRefreshToken();
  }

  const refreshTokenHash = hashToken(
    refreshToken,
  );

  const dbSession = await mongoose.startSession();

  try {
    let result:
      | RefreshLoginSessionResult
      | undefined;

    await dbSession.withTransaction(
      async () => {
        const currentSession =
          await findSessionByRefreshTokenHash(
            refreshTokenHash,
            dbSession,
          );

        if (!currentSession) {
          throw invalidRefreshToken();
        }

        if (currentSession.revokedAt) {
          throw new RefreshTokenReuseError(
            currentSession.tokenFamilyId,
          );
        }

        if (
          currentSession.expiresAt.getTime() <=
          Date.now()
        ) {
          throw invalidRefreshToken();
        }

        const user = await findUserById(
          currentSession.userId,
          dbSession,
        );

        if (!user || user.status !== "ACTIVE") {
          throw new AppError(
            403,
            "ACCOUNT_NOT_ACTIVE",
            "Account is not active",
          );
        }

        const organization =
          await findOrganizationById(
            currentSession.organizationId,
            dbSession,
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

        const newRefreshToken =
          generateRefreshToken();

        const newRefreshTokenHash =
          hashToken(newRefreshToken);

        // Keep the original session expiry so the
        // refresh-token family has a fixed lifetime.
        const newSession =
          await rotateSession(
            currentSession._id,
            {
              userId: currentSession.userId,
              organizationId:
                currentSession.organizationId,
              tokenFamilyId:
                currentSession.tokenFamilyId,
              refreshTokenHash:
                newRefreshTokenHash,
              expiresAt:
                currentSession.expiresAt,
            },
            dbSession,
          );

        const accessToken =
          generateAccessToken({
            sub: user._id.toString(),
            organizationId:
              organization._id.toString(),
            sessionId:
              newSession._id.toString(),
          });

        result = {
          accessToken,
          refreshToken: newRefreshToken,
          expiresAt: newSession.expiresAt,
          sessionId:
            newSession._id.toString(),
        };
      },
    );

    if (!result) {
      throw new Error(
        "Unable to refresh session",
      );
    }

    return result;
  } catch (error) {
    if (
      error instanceof RefreshTokenReuseError
    ) {
      await revokeTokenFamily(
        error.tokenFamilyId,
      );

      // Detection and family revocation above are unchanged; the client
      // only ever sees the generic error.
      throw invalidRefreshToken();
    }

    throw error;
  } finally {
    await dbSession.endSession();
  }
};