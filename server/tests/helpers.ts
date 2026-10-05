import argon2 from "argon2";
import mongoose from "mongoose";

import { Organization } from "../src/models/organization.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import { createLoginSession } from "../src/services/session.service.js";

export const TEST_PASSWORD = "Correct-Horse-Battery-9";

let counter = 0;

const nextId = (): number => {
  counter += 1;
  return counter;
};

export interface TestUser {
  userId: string;
  organizationId: string;
  email: string;
}

export interface TestSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}

/*
 * Creates an organization and an active, verified user directly in the
 * database (registration sends email, which tests must not do).
 */
export const createTestUser = async (
  options: { organizationId?: string } = {},
): Promise<TestUser> => {
  const id = nextId();

  const organizationId =
    options.organizationId ??
    (
      await Organization.create({
        name: `Test Org ${id}`,
        slug: `test-org-${id}-${Date.now()}`,
      })
    )._id.toString();

  const email = `user${id}-${Date.now()}@example.com`;

  const user = await User.create({
    organizationId,
    firstName: "Test",
    lastName: `User${id}`,
    email,
    passwordHash: await argon2.hash(TEST_PASSWORD),
    emailVerified: true,
    status: "ACTIVE",
  });

  return {
    userId: user._id.toString(),
    organizationId,
    email,
  };
};

/*
 * Creates a real server-side session plus access/refresh tokens using
 * the production session service.
 */
export const createTestSession = async (
  user: TestUser,
): Promise<TestSession> => {
  const result = await createLoginSession(
    user.userId,
    user.organizationId,
  );

  return {
    sessionId: result.sessionId,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  };
};

export const bearer = (accessToken: string): string => {
  return `Bearer ${accessToken}`;
};

export const getSessionFromDb = async (sessionId: string) => {
  return Session.findById(sessionId).exec();
};

export const objectId = (): string => {
  return new mongoose.Types.ObjectId().toString();
};

/*
 * Returns the raw Set-Cookie header lines of a supertest response.
 */
export const getSetCookies = (headers: {
  [key: string]: unknown;
}): string[] => {
  const value = headers["set-cookie"];

  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string",
    );
  }

  return [];
};

export const isRefreshCookieCleared = (
  setCookies: string[],
): boolean => {
  return setCookies.some(
    (cookie) =>
      cookie.startsWith("refreshToken=;") &&
      cookie.includes("Path=/api/auth") &&
      /Expires=/i.test(cookie),
  );
};
