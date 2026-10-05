import { type ClientSession } from "mongoose";

import {
  Session,
  type ISession,
} from "../models/session.model.js";

export const createSession = async (
  data: Pick<
    ISession,
    | "userId"
    | "organizationId"
    | "tokenFamilyId"
    | "refreshTokenHash"
    | "expiresAt"
  >,
  dbSession?: ClientSession,
): Promise<ISession> => {
  const session = new Session({
    userId: data.userId,
    organizationId: data.organizationId,
    tokenFamilyId: data.tokenFamilyId,
    refreshTokenHash: data.refreshTokenHash,
    expiresAt: data.expiresAt,
    revokedAt: null,
  });

  await session.save({
    session: dbSession,
  });

  return session;
};

export const findSessionByRefreshTokenHash =
  async (
    refreshTokenHash: string,
    dbSession?: ClientSession,
  ): Promise<ISession | null> => {
    const query = Session.findOne({
      refreshTokenHash,
    });

    if (dbSession) {
      query.session(dbSession);
    }

    return query.exec();
  };

export const rotateSession = async (
  currentSessionId: ISession["_id"],
  data: Pick<
    ISession,
    | "userId"
    | "organizationId"
    | "tokenFamilyId"
    | "refreshTokenHash"
    | "expiresAt"
  >,
  dbSession: ClientSession,
): Promise<ISession> => {
  const revokedAt = new Date();

  const revokeResult = await Session.updateOne(
    {
      _id: currentSessionId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt,
      },
    },
    {
      session: dbSession,
    },
  ).exec();

  if (revokeResult.modifiedCount !== 1) {
    throw new Error("SESSION_ALREADY_REVOKED");
  }

  const newSession = new Session({
    userId: data.userId,
    organizationId: data.organizationId,
    tokenFamilyId: data.tokenFamilyId,
    refreshTokenHash: data.refreshTokenHash,
    expiresAt: data.expiresAt,
    revokedAt: null,
  });

  await newSession.save({
    session: dbSession,
  });

  return newSession;
};

export const revokeSession = async (
  sessionId: string,
  dbSession?: ClientSession,
): Promise<boolean> => {
  const result = await Session.updateOne(
    {
      _id: sessionId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
      },
    },
    {
      session: dbSession,
    },
  ).exec();

  return result.modifiedCount === 1;
};

/*
 * Session-management queries (8.12).
 *
 * Every function below is scoped by the authenticated userId AND
 * organizationId, and only touches sessions that are still active
 * (not revoked, not expired). Never look up a session by _id alone
 * on behalf of a user.
 */

export const findActiveSessionsForUser = async (
  userId: ISession["userId"],
  organizationId: ISession["organizationId"],
): Promise<ISession[]> => {
  return Session.find({
    userId,
    organizationId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1, _id: -1 })
    .exec();
};

export const revokeActiveSessionForUser = async (
  sessionId: ISession["_id"],
  userId: ISession["userId"],
  organizationId: ISession["organizationId"],
  dbSession?: ClientSession,
): Promise<boolean> => {
  const now = new Date();

  const result = await Session.updateOne(
    {
      _id: sessionId,
      userId,
      organizationId,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        revokedAt: now,
      },
    },
    {
      session: dbSession,
    },
  ).exec();

  return result.modifiedCount === 1;
};

export const revokeAllActiveSessionsForUser = async (
  userId: ISession["userId"],
  organizationId: ISession["organizationId"],
  dbSession?: ClientSession,
): Promise<number> => {
  const now = new Date();

  const result = await Session.updateMany(
    {
      userId,
      organizationId,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    {
      $set: {
        revokedAt: now,
      },
    },
    {
      session: dbSession,
    },
  ).exec();

  return result.modifiedCount;
};

export const revokeTokenFamily = async (
  tokenFamilyId: string,
  dbSession?: ClientSession,
): Promise<number> => {
  const result = await Session.updateMany(
    {
      tokenFamilyId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
      },
    },
    {
      session: dbSession,
    },
  ).exec();

  return result.modifiedCount;
};