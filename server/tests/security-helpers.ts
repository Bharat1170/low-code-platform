import jwt from "jsonwebtoken";
import { expect } from "vitest";

import { env } from "../src/config/env.js";
import { redisClient } from "../src/config/redis.js";

import { objectId, type TestUser } from "./helpers.js";

/*
 * Shared helpers for the 8.15.11 security suite.
 */

/*
 * Values that must never appear in any client response or log:
 * server secrets and connection strings.
 */
export const serverSecrets = (): string[] => [
  env.JWT_ACCESS_SECRET,
  env.JWT_REFRESH_SECRET,
  env.EMAIL_PASSWORD,
  env.MONGO_URI,
  env.REDIS_URL,
];

/*
 * Clears the Redis counters of the rate limiters and the progressive
 * login-delay tracker. The limiters run BEFORE validation, so tests that
 * send many invalid requests would otherwise hit 429.
 */
export const resetRateLimits = async (): Promise<void> => {
  const keys = [
    ...(await redisClient.keys("auth:*-rate:*")),
    ...(await redisClient.keys("auth:login-rate:*")),
    ...(await redisClient.keys("auth:login-failure:*")),
  ];

  if (keys.length > 0) {
    await redisClient.del(keys);
  }
};

export interface ErrorBody {
  success: boolean;
  error: { code: string; message: string; fields: unknown };
}

/*
 * Standard error format: exactly { success:false, error:{code,message,fields} }.
 */
export const expectStandardError = (
  body: ErrorBody,
  code?: string,
): void => {
  expect(body.success).toBe(false);
  expect(Object.keys(body).sort()).toEqual(["error", "success"]);
  expect(Object.keys(body.error).sort()).toEqual([
    "code",
    "fields",
    "message",
  ]);

  if (code !== undefined) {
    expect(body.error.code).toBe(code);
  }
};

const FORBIDDEN_FRAGMENTS = [
  "stack",
  "node_modules",
  "src/",
  "src\\\\",
  "tests/",
  "mongodb://",
  "redis://",
  "E11000",
  "email_1",
  "MongoServerError",
  "MongooseError",
  "CastError",
  "BSONError",
  "ValidationError",
  "JsonWebTokenError",
  "TokenExpiredError",
  "NotBeforeError",
  "argon2",
  "pchstr",
  "low_code_platform",
  "JWT_",
  "passwordHash",
  "refreshTokenHash",
  "tokenFamilyId",
  "ECONNREFUSED",
];

/*
 * Nothing about the implementation or infrastructure may reach a client.
 */
/*
 * `allow` lists fragments that may legitimately appear because the CLIENT
 * sent them (for example strict-schema errors echo an unknown key name).
 */
export const expectNoInternals = (
  value: unknown,
  allow: string[] = [],
): void => {
  const raw = typeof value === "string" ? value : JSON.stringify(value);

  for (const fragment of FORBIDDEN_FRAGMENTS) {
    if (allow.includes(fragment)) {
      continue;
    }

    expect(raw).not.toContain(fragment);
  }

  for (const secret of serverSecrets()) {
    expect(raw).not.toContain(secret);
  }
};

export const signAccessToken = (
  user: Pick<TestUser, "userId" | "organizationId">,
  overrides: {
    claims?: Record<string, unknown>;
    subject?: string | null;
    options?: jwt.SignOptions;
    secret?: string;
  } = {},
): string => {
  const claims: Record<string, unknown> = {
    organizationId: user.organizationId,
    sessionId: objectId(),
    type: "access",
    ...overrides.claims,
  };

  const options: jwt.SignOptions = {
    algorithm: "HS256",
    ...overrides.options,
  };

  if (overrides.subject !== null) {
    options.subject = overrides.subject ?? user.userId;
  }

  return jwt.sign(claims, overrides.secret ?? env.JWT_ACCESS_SECRET, options);
};
