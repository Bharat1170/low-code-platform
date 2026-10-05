import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { AUTH_CONSTANTS } from "../src/constants/auth.constants.js";
import { User } from "../src/models/user.model.js";
import { saveVerificationToken } from "../src/repositories/verification-token.repository.js";
import * as emailService from "../src/services/email.service.js";
import { generateSecureToken, hashToken } from "../src/utils/token.util.js";

import { createTestUser } from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  type ErrorBody,
} from "./security-helpers.js";

vi.mock("../src/services/email.service.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/services/email.service.js")
    >();

  return {
    ...original,
    sendVerificationEmail: vi.fn(),
  };
});

/*
 * 8.15.11 / 6 - Email verification.
 */

const sendMock = vi.mocked(emailService.sendVerificationEmail);

const tokenKey = (token: string): string =>
  `auth:email-verification:${hashToken(token)}`;

const lastEmailedToken = (): string => {
  const call = sendMock.mock.calls.at(-1);

  if (!call) {
    throw new Error("No verification email was sent");
  }

  const token = new URL(call[1]).searchParams.get("token");

  if (!token) {
    throw new Error("Verification URL has no token");
  }

  return token;
};

const verify = (token: string) =>
  request(app).get("/api/auth/verify-email").query({ token });

const resend = (email: string, organizationId: string) =>
  request(app)
    .post("/api/auth/resend-verification")
    .send({ email, organizationId });

const registerAccount = async (
  email = `verify-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
) => {
  const res = await request(app)
    .post("/api/auth/register")
    .send({
      firstName: "Ver",
      lastName: "Ify",
      email,
      password: "Verification-Passw0rd!",
      organizationName: "Verify Org",
    });

  expect(res.status).toBe(201);

  return {
    email,
    userId: res.body.data.userId as string,
    organizationId: res.body.data.organizationId as string,
    registerResponse: res,
  };
};

const unverifiedUser = async () => {
  const user = await createTestUser();

  await User.updateOne(
    { _id: user.userId },
    { $set: { emailVerified: false } },
  );

  return user;
};

const GENERIC_RESEND = {
  success: true,
  message:
    "If the account exists and requires verification, a verification email has been sent.",
};

beforeEach(() => {
  sendMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verification token storage", () => {
  it("stores only a hash of the token in Redis, with a 24-hour lifetime", async () => {
    const account = await registerAccount();
    const token = lastEmailedToken();

    expect(token).toMatch(/^[a-f0-9]{64}$/);

    expect(await redisClient.exists(tokenKey(token))).toBe(1);
    expect(await redisClient.get(tokenKey(token))).toBe(account.userId);

    for (const key of await redisClient.keys("*")) {
      expect(key).not.toContain(token);
    }

    const ttl = await redisClient.ttl(tokenKey(token));
    expect(ttl).toBeGreaterThan(
      AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS - 30,
    );
    expect(ttl).toBeLessThanOrEqual(
      AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
    );
  });

  it("never returns the token or its hash from registration or verification", async () => {
    const account = await registerAccount();
    const token = lastEmailedToken();

    const verified = await verify(token);

    for (const res of [account.registerResponse, verified]) {
      const raw = JSON.stringify(res.body);

      expect(raw).not.toContain(token);
      expect(raw).not.toContain(hashToken(token));
      expect(JSON.stringify(res.headers)).not.toContain(token);
      expectNoInternals(res.body);
    }
  });

  it("does not write the token or its hash to any log", async () => {
    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
    ];

    const account = await registerAccount();
    const token = lastEmailedToken();

    await verify(token);
    await verify(token);
    await verify("e".repeat(64));

    const user = await User.findById(account.userId).exec();
    await User.updateOne({ _id: user?._id }, { $set: { emailVerified: false } });
    await resend(account.email, account.organizationId);

    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));

    for (const secret of [
      token,
      hashToken(token),
      lastEmailedToken(),
      hashToken(lastEmailedToken()),
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("verifying an email", () => {
  it("accepts a valid token exactly once", async () => {
    const account = await registerAccount();
    const token = lastEmailedToken();

    const first = await verify(token);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      success: true,
      message: "Email verified successfully",
    });
    expect(
      (await User.findById(account.userId).exec())?.emailVerified,
    ).toBe(true);

    // Consumed immediately.
    expect(await redisClient.exists(tokenKey(token))).toBe(0);

    const second = await verify(token);

    expect(second.status).toBe(400);
    expectStandardError(second.body as ErrorBody, "INVALID_OR_EXPIRED_TOKEN");
  });

  it("rejects an invalid, unknown or expired token with one identical error", async () => {
    const account = await registerAccount();
    const token = lastEmailedToken();

    await redisClient.pExpire(tokenKey(token), 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const expired = await verify(token);
    const unknown = await verify("a".repeat(64));

    for (const res of [expired, unknown]) {
      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "INVALID_OR_EXPIRED_TOKEN");
      expectNoInternals(res.body);
    }

    expect(expired.body).toEqual(unknown.body);

    // The account stays unverified.
    expect(
      (await User.findById(account.userId).exec())?.emailVerified,
    ).toBe(false);
  });

  it("gives the same generic error when the user is already verified or inactive", async () => {
    const verified = await createTestUser();
    const suspended = await unverifiedUser();
    await User.updateOne(
      { _id: suspended.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const unknown = await verify("b".repeat(64));

    for (const user of [verified, suspended]) {
      const token = generateSecureToken(32);

      await saveVerificationToken(
        hashToken(token),
        user.userId,
        AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
      );

      const res = await verify(token);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(unknown.body);
    }

    // A suspended account must not become verified through this route.
    expect(
      (await User.findById(suspended.userId).exec())?.emailVerified,
    ).toBe(false);
  });

  it("rejects malformed tokens before touching Redis", async () => {
    const get = vi.spyOn(redisClient, "getDel");

    for (const token of ["", "abc", "g".repeat(64), "a".repeat(63)]) {
      const res = await verify(token);

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect(get).not.toHaveBeenCalled();
  });
});

describe("resending the verification email", () => {
  it("sends one email, then answers identically during the 60-second cooldown", async () => {
    const user = await unverifiedUser();

    const first = await resend(user.email, user.organizationId);
    const second = await resend(user.email, user.organizationId);
    const third = await resend(user.email, user.organizationId);

    for (const res of [first, second, third]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(GENERIC_RESEND);
    }

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe(user.email);

    const cooldownKeys = await redisClient.keys(
      "auth:email-verification-resend:*",
    );

    expect(cooldownKeys).toHaveLength(1);
    expect(cooldownKeys[0]).not.toContain(user.email);
    expect(cooldownKeys[0]).not.toContain(user.organizationId);

    const ttl = await redisClient.ttl(cooldownKeys[0] as string);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(
      AUTH_CONSTANTS.RESEND_VERIFICATION_COOLDOWN_SECONDS,
    );
  });

  it("issues a working token when it does send", async () => {
    const user = await unverifiedUser();

    await resend(user.email, user.organizationId);

    const token = lastEmailedToken();

    expect((await verify(token)).status).toBe(200);
    expect(
      (await User.findById(user.userId).exec())?.emailVerified,
    ).toBe(true);
  });

  it("sends nothing, and answers identically, for verified, unknown, inactive or foreign-organization accounts", async () => {
    const alreadyVerified = await createTestUser();

    const suspended = await unverifiedUser();
    await User.updateOne(
      { _id: suspended.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const real = await unverifiedUser();
    const foreignOrg = await createTestUser();

    const responses = [
      await resend(alreadyVerified.email, alreadyVerified.organizationId),
      await resend(suspended.email, suspended.organizationId),
      await resend("nobody@example.com", real.organizationId),
      await resend("nobody@example.com", "0".repeat(24)),
      // Right email, but another tenant's organization id.
      await resend(real.email, foreignOrg.organizationId),
    ];

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(GENERIC_RESEND);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does not reveal the token, hash or account state in the response", async () => {
    const user = await unverifiedUser();

    const res = await resend(user.email, user.organizationId);
    const token = lastEmailedToken();
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain(token);
    expect(raw).not.toContain(hashToken(token));
    expect(raw).not.toContain(user.email);
    expect(raw).not.toContain(user.userId);
    expectNoInternals(res.body);
  });

  it("keeps the cooldown per organization and email (no cross-tenant interference)", async () => {
    const a = await unverifiedUser();
    const b = await unverifiedUser();

    await resend(a.email, a.organizationId);
    await resend(b.email, b.organizationId);

    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
