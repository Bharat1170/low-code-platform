import argon2 from "argon2";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { env } from "../src/config/env.js";
import { redisClient } from "../src/config/redis.js";
import { AUTH_CONSTANTS } from "../src/constants/auth.constants.js";
import {
  PERMISSIONS,
  type Permission,
} from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS } from "../src/constants/roles.js";
import { authenticate } from "../src/middleware/auth.middleware.js";
import { requirePermission } from "../src/middleware/authorization.middleware.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Organization } from "../src/models/organization.model.js";
import { Role } from "../src/models/role.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import * as emailService from "../src/services/email.service.js";
import {
  loadActiveAccount,
  resolvePermissions,
} from "../src/services/authorization.service.js";
import { sendSuccess } from "../src/utils/response.js";
import { hashToken } from "../src/utils/token.util.js";

import { bearer, getSetCookies, objectId } from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  resetRateLimits,
  serverSecrets,
  signAccessToken,
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
    sendPasswordResetEmail: vi.fn(),
    sendPasswordChangedEmail: vi.fn(),
  };
});

/*
 * 8.15.12 - Final authentication acceptance test.
 *
 * One continuous story through the REAL HTTP API (routes, middleware,
 * services, MongoDB, Redis). Only the outbound email transport is
 * replaced, to capture the tokens that would be emailed.
 *
 * It is a single test because tests/setup.ts wipes the database between
 * tests. step() names the acceptance step that failed.
 */

const sendVerification = vi.mocked(emailService.sendVerificationEmail);
const sendReset = vi.mocked(emailService.sendPasswordResetEmail);

const AGENT = "acceptance-agent";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface Account {
  label: string;
  email: string;
  password: string;
  userId: string;
  organizationId: string;
  successfulLogins: number;
}

interface LoggedIn {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  response: request.Response;
}

const completedSteps: string[] = [];

const step = async (
  name: string,
  run: () => Promise<void>,
): Promise<void> => {
  try {
    await run();
    completedSteps.push(name);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new Error(`ACCEPTANCE STEP FAILED: ${name}\n${detail}`, {
      cause: error,
    });
  }
};

const refreshCookie = (
  headers: { [key: string]: unknown },
): { value: string; raw: string } => {
  for (const raw of getSetCookies(headers)) {
    const match = /^refreshToken=([^;]*);/.exec(raw);

    if (match) {
      return { value: match[1] ?? "", raw };
    }
  }

  throw new Error("No refresh cookie was set");
};

const tokenFromEmail = (url: string | undefined): string => {
  const token = new URL(url ?? "http://missing/").searchParams.get("token");

  if (!token) {
    throw new Error("No token in the emailed URL");
  }

  return token;
};

const sessionsOf = (userId: string) =>
  Session.find({ userId }).select("+refreshTokenHash").exec();

const activeSessionsOf = (userId: string) =>
  Session.find({ userId, revokedAt: null }).exec();

describe("8.15.12 final authentication acceptance", () => {
  it("registration -> verification -> login -> refresh -> logout -> reset -> change -> sessions -> status -> tenancy -> audit", async () => {
    // Everything logged during the lifecycle is scanned for secrets.
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
    ];

    // Every secret that ever exists in the story, collected as it appears.
    const passwords: string[] = [];
    const passwordHashes: string[] = [];
    const rawTokens: string[] = [];
    const refreshTokens: string[] = [];
    const accessTokens: string[] = [];

    const alice: Account = {
      label: "alice",
      email: `alice-${Date.now()}@example.com`,
      password: "Alice-Initial-Passw0rd!",
      userId: "",
      organizationId: "",
      successfulLogins: 0,
    };
    const bob: Account = {
      label: "bob",
      email: `bob-${Date.now()}@example.com`,
      password: "Bob-Initial-Passw0rd!",
      userId: "",
      organizationId: "",
      successfulLogins: 0,
    };
    passwords.push(alice.password, bob.password);

    // Test-only route using the real middleware chain that future business
    // routes will use: authenticate -> requirePermission (-> account status).
    const guarded = express();
    guarded.use(express.json());
    guarded.post(
      "/forms",
      authenticate,
      requirePermission(PERMISSIONS.FORM_CREATE as Permission),
      (_req, res) => {
        sendSuccess(res, 200, "ok");
      },
    );
    guarded.use(errorHandler);

    const register = (account: Account, organizationName: string) =>
      request(app)
        .post("/api/auth/register")
        .set("User-Agent", AGENT)
        .send({
          firstName: account.label,
          lastName: "Acceptance",
          email: account.email,
          password: account.password,
          organizationName,
        });

    const loginAs = async (
      account: Account,
      password: string,
    ): Promise<LoggedIn> => {
      const response = await request(app)
        .post("/api/auth/login")
        .set("User-Agent", AGENT)
        .send({ email: account.email, password });

      expect(response.status).toBe(200);

      account.successfulLogins += 1;

      const accessToken = response.body.data.accessToken as string;
      const refreshToken = refreshCookie(response.headers).value;
      const claims = jwt.verify(accessToken, env.JWT_ACCESS_SECRET) as {
        sessionId: string;
      };

      accessTokens.push(accessToken);
      refreshTokens.push(refreshToken);

      return {
        accessToken,
        refreshToken,
        sessionId: claims.sessionId,
        response,
      };
    };

    const hashOf = async (userId: string): Promise<string> => {
      const user = await User.findById(userId).select("+passwordHash").exec();
      const hash = user?.passwordHash ?? "";

      passwordHashes.push(hash);

      return hash;
    };

    const auditsOf = (userId: string, action?: string) =>
      AuditLog.find({ userId, ...(action ? { action } : {}) })
        .sort({ createdAt: 1 })
        .exec();

    const scanForSecrets = (label: string, text: string): void => {
      for (const secret of [
        ...passwords,
        ...passwordHashes,
        ...rawTokens,
        ...rawTokens.map(hashToken),
        ...refreshTokens,
        ...refreshTokens.map(hashToken),
        ...serverSecrets(),
      ]) {
        if (secret && text.includes(secret)) {
          throw new Error(`${label} contains a secret`);
        }
      }
    };

    let genericVerifyError: unknown;
    let genericRefreshError: unknown;

    // ===================================================================
    // 1. Registration
    // ===================================================================
    let aliceVerificationToken = "";

    await step("1. Registration", async () => {
      const res = await register(alice, "Alice Org");

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(Object.keys(res.body.data).sort()).toEqual([
        "email",
        "organizationId",
        "userId",
      ]);

      alice.userId = res.body.data.userId as string;
      alice.organizationId = res.body.data.organizationId as string;

      // Organization, OWNER role and user exist.
      const organization = await Organization.findById(
        alice.organizationId,
      ).exec();
      expect(organization?.name).toBe("Alice Org");
      expect(organization?.status).toBe("ACTIVE");

      const role = await Role.findOne({
        organizationId: alice.organizationId,
        name: "OWNER",
      }).exec();
      expect([...(role?.permissions ?? [])].sort()).toEqual(
        [...OWNER_PERMISSIONS].sort(),
      );

      const user = await User.findById(alice.userId)
        .select("+passwordHash")
        .exec();
      expect(user?.organizationId.toString()).toBe(alice.organizationId);
      expect(user?.roleIds.map(String)).toEqual([role?._id.toString()]);
      expect(user?.status).toBe("ACTIVE");
      expect(user?.emailVerified).toBe(false);

      // Password stored only as an Argon2 hash.
      const hash = await hashOf(alice.userId);
      expect(hash).toMatch(/^\$argon2/);
      expect(hash).not.toContain(alice.password);
      expect(await argon2.verify(hash, alice.password)).toBe(true);

      // Verification token: emailed raw, stored only as a hash with a TTL.
      expect(sendVerification).toHaveBeenCalledTimes(1);
      expect(sendVerification.mock.calls[0]?.[0]).toBe(alice.email);
      aliceVerificationToken = tokenFromEmail(
        sendVerification.mock.calls[0]?.[1],
      );
      rawTokens.push(aliceVerificationToken);

      const key = `auth:email-verification:${hashToken(aliceVerificationToken)}`;
      expect(await redisClient.get(key)).toBe(alice.userId);

      const ttl = await redisClient.ttl(key);
      expect(ttl).toBeGreaterThan(
        AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS - 30,
      );
      expect(ttl).toBeLessThanOrEqual(
        AUTH_CONSTANTS.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
      );

      for (const redisKey of await redisClient.keys("*")) {
        expect(redisKey).not.toContain(aliceVerificationToken);
      }

      // USER_REGISTERED audit.
      const audits = await auditsOf(alice.userId, "USER_REGISTERED");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.organizationId.toString()).toBe(alice.organizationId);
      expect(audits[0]?.resourceType).toBe("USER");
      expect(audits[0]?.resourceId?.toString()).toBe(alice.userId);
      expect(audits[0]?.metadata).toEqual({});
      expect(audits[0]?.userAgent).toBe(AGENT);

      // No secret in the response.
      scanForSecrets("registration response", res.text);
      expectNoInternals(res.body);
    });

    // ===================================================================
    // 2. Email verification
    // ===================================================================
    await step("2. Email verification", async () => {
      // Invalid token: safe, generic response.
      const unknown = await request(app)
        .get("/api/auth/verify-email")
        .query({ token: "a".repeat(64) });

      expect(unknown.status).toBe(400);
      expectStandardError(unknown.body as ErrorBody, "INVALID_OR_EXPIRED_TOKEN");
      genericVerifyError = unknown.body;

      // Valid token verifies the user and is consumed.
      const key = `auth:email-verification:${hashToken(aliceVerificationToken)}`;

      const ok = await request(app)
        .get("/api/auth/verify-email")
        .query({ token: aliceVerificationToken });

      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        success: true,
        message: "Email verified successfully",
      });
      expect(
        (await User.findById(alice.userId).exec())?.emailVerified,
      ).toBe(true);
      expect(await redisClient.exists(key)).toBe(0);

      // Reuse is rejected with the identical generic response.
      const reused = await request(app)
        .get("/api/auth/verify-email")
        .query({ token: aliceVerificationToken });

      expect(reused.status).toBe(400);
      expect(reused.body).toEqual(genericVerifyError);

      // Verification itself writes no audit record (current design).
      expect(await auditsOf(alice.userId)).toHaveLength(1);

      scanForSecrets("verification response", ok.text + reused.text);

      // Expired token (Bob), then resend and verify.
      const bobRegistration = await register(bob, "Bob Org");
      expect(bobRegistration.status).toBe(201);
      bob.userId = bobRegistration.body.data.userId as string;
      bob.organizationId = bobRegistration.body.data.organizationId as string;
      await hashOf(bob.userId);

      const bobFirstToken = tokenFromEmail(
        sendVerification.mock.calls.at(-1)?.[1],
      );
      rawTokens.push(bobFirstToken);

      await redisClient.pExpire(
        `auth:email-verification:${hashToken(bobFirstToken)}`,
        1,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      const expired = await request(app)
        .get("/api/auth/verify-email")
        .query({ token: bobFirstToken });

      expect(expired.status).toBe(400);
      expect(expired.body).toEqual(genericVerifyError);

      // CURRENT BEHAVIOR / OPEN PRODUCT DECISION (not a stated requirement):
      // login does not require a verified email. Bob is still unverified
      // here and can log in. Verification currently gates only
      // forgot-password and resend. If the product later requires
      // verified-only login, this expectation must be changed deliberately.
      const unverifiedLogin = await loginAs(bob, bob.password);
      expect(unverifiedLogin.response.status).toBe(200);

      // Bob's address is not verified yet; resend-verification answers
      // generically and issues a working token.
      const resend = await request(app)
        .post("/api/auth/resend-verification")
        .send({ email: bob.email, organizationId: bob.organizationId });

      expect(resend.status).toBe(200);
      expect(resend.body.success).toBe(true);

      const bobSecondToken = tokenFromEmail(
        sendVerification.mock.calls.at(-1)?.[1],
      );
      rawTokens.push(bobSecondToken);

      expect(
        (
          await request(app)
            .get("/api/auth/verify-email")
            .query({ token: bobSecondToken })
        ).status,
      ).toBe(200);
      expect(
        (await User.findById(bob.userId).exec())?.emailVerified,
      ).toBe(true);
    });

    // ===================================================================
    // 3. Login
    // ===================================================================
    let aliceFirst: LoggedIn;

    await step("3. Login", async () => {
      aliceFirst = await loginAs(alice, alice.password);

      const res = aliceFirst.response;

      // Access token in the body; refresh token ONLY in the cookie.
      expect(res.body.success).toBe(true);
      expect(Object.keys(res.body.data).sort()).toEqual([
        "accessToken",
        "expiresAt",
        "user",
      ]);
      expect(res.body.data.user).toEqual({
        id: alice.userId,
        firstName: "alice",
        lastName: "Acceptance",
        email: alice.email,
        organizationId: alice.organizationId,
      });
      expect(res.text).not.toContain(aliceFirst.refreshToken);
      expect(res.text).not.toContain(hashToken(aliceFirst.refreshToken));
      expect(res.text).not.toContain("refreshToken");

      const cookie = refreshCookie(res.headers);
      expect(cookie.raw).toContain("HttpOnly");
      expect(cookie.raw).toContain("SameSite=Lax");
      expect(cookie.raw).toContain("Path=/api/auth");
      expect(cookie.value).toMatch(/^[a-f0-9]{64}$/);

      // JWT claims.
      const claims = jwt.verify(
        aliceFirst.accessToken,
        env.JWT_ACCESS_SECRET,
      ) as Record<string, unknown>;
      expect(claims.sub).toBe(alice.userId);
      expect(claims.organizationId).toBe(alice.organizationId);
      expect(claims.type).toBe("access");

      // Session created; only the refresh token HASH is stored.
      const sessions = await sessionsOf(alice.userId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?._id.toString()).toBe(aliceFirst.sessionId);
      expect(sessions[0]?.refreshTokenHash).toBe(
        hashToken(aliceFirst.refreshToken),
      );
      expect(JSON.stringify(sessions)).not.toContain(
        aliceFirst.refreshToken,
      );

      // Login audit.
      const audits = await auditsOf(alice.userId, "USER_LOGIN");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.organizationId.toString()).toBe(alice.organizationId);
      expect(audits[0]?.metadata).toMatchObject({
        sessionId: aliceFirst.sessionId,
      });
      expect(audits[0]?.userAgent).toBe(AGENT);

      scanForSecrets("login response", res.text);
    });

    // ===================================================================
    // 4. Authenticated request
    // ===================================================================
    await step("4. Authenticated requests", async () => {
      const ok = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(aliceFirst.accessToken));

      expect(ok.status).toBe(200);
      expect(ok.body.success).toBe(true);

      const valid = aliceFirst.accessToken;

      const failures = [
        await request(app).get("/api/auth/sessions"),
        await request(app)
          .get("/api/auth/sessions")
          .set("Authorization", "Bearer not.a.jwt"),
        await request(app)
          .get("/api/auth/sessions")
          .set(
            "Authorization",
            bearer(
              signAccessToken(
                { userId: alice.userId, organizationId: alice.organizationId },
                { options: { expiresIn: -10 } },
              ),
            ),
          ),
        await request(app)
          .get("/api/auth/sessions")
          .set("Authorization", bearer(`${valid.slice(0, -4)}AAAA`)),
      ];

      for (const res of failures) {
        expect(res.status).toBe(401);
        expectStandardError(res.body as ErrorBody, "UNAUTHORIZED");
        expectNoInternals(res.body);
      }
    });

    // ===================================================================
    // 5. Refresh rotation
    // ===================================================================
    let aliceRotated: { accessToken: string; refreshToken: string };

    await step("5. Refresh rotation", async () => {
      const before = await Session.findById(aliceFirst.sessionId)
        .select("+refreshTokenHash")
        .exec();

      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${aliceFirst.refreshToken}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual([
        "accessToken",
        "expiresAt",
      ]);

      const newAccessToken = res.body.data.accessToken as string;
      const newRefreshToken = refreshCookie(res.headers).value;

      accessTokens.push(newAccessToken);
      refreshTokens.push(newRefreshToken);
      aliceRotated = {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };

      expect(newAccessToken).not.toBe(aliceFirst.accessToken);
      expect(newRefreshToken).not.toBe(aliceFirst.refreshToken);
      expect(res.text).not.toContain(newRefreshToken);

      // Old session revoked; new session in the same family with the
      // original expiry (fixed family lifetime).
      const old = await Session.findById(aliceFirst.sessionId).exec();
      expect(old?.revokedAt).toBeInstanceOf(Date);

      const active = await activeSessionsOf(alice.userId);
      expect(active).toHaveLength(1);
      expect(active[0]?._id.toString()).not.toBe(aliceFirst.sessionId);

      const fresh = await Session.findById(active[0]?._id)
        .select("+refreshTokenHash")
        .exec();

      expect(fresh?.tokenFamilyId).toBe(before?.tokenFamilyId);
      expect(fresh?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
      expect(
        Math.abs(
          (before?.expiresAt.getTime() ?? 0) - (Date.now() + SEVEN_DAYS_MS),
        ),
      ).toBeLessThan(5 * 60 * 1000);

      // Only hashes are stored.
      expect(fresh?.refreshTokenHash).toBe(hashToken(newRefreshToken));
      const stored = JSON.stringify(await sessionsOf(alice.userId));
      expect(stored).not.toContain(aliceFirst.refreshToken);
      expect(stored).not.toContain(newRefreshToken);

      // The new access token belongs to the new session.
      const list = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(newAccessToken));

      expect(list.status).toBe(200);
      expect(list.body.data.sessions).toHaveLength(1);
      expect(list.body.data.sessions[0].current).toBe(true);
    });

    // ===================================================================
    // 6. Refresh reuse
    // ===================================================================
    let aliceDevice2: LoggedIn;

    await step("6. Refresh reuse protection", async () => {
      // An unrelated login (second device) of the same user.
      aliceDevice2 = await loginAs(alice, alice.password);

      const unknown = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${"9".repeat(64)}`);
      genericRefreshError = unknown.body;

      // Replay the OLD (already rotated) token.
      const replay = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${aliceFirst.refreshToken}`);

      expect(replay.status).toBe(401);
      expectStandardError(replay.body as ErrorBody, "INVALID_REFRESH_TOKEN");
      expect(replay.body).toEqual(genericRefreshError);
      expect(replay.headers["set-cookie"]).toBeUndefined();
      expectNoInternals(replay.body);

      // The whole family is revoked: the legitimate rotated token is dead.
      const rotatedAttempt = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${aliceRotated.refreshToken}`);
      expect(rotatedAttempt.status).toBe(401);

      // The unrelated login is untouched.
      const device2Session = await Session.findById(
        aliceDevice2.sessionId,
      ).exec();
      expect(device2Session?.revokedAt ?? null).toBeNull();

      const list = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(aliceDevice2.accessToken));

      expect(list.status).toBe(200);
      expect(
        list.body.data.sessions.map((s: { id: string }) => s.id),
      ).toEqual([aliceDevice2.sessionId]);
    });

    // ===================================================================
    // 7. Logout
    // ===================================================================
    await step("7. Logout", async () => {
      const res = await request(app)
        .post("/api/auth/logout")
        .set("User-Agent", AGENT)
        .set("Cookie", `refreshToken=${aliceDevice2.refreshToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Cookie cleared with matching attributes.
      const cleared = refreshCookie(res.headers);
      expect(cleared.value).toBe("");
      expect(cleared.raw).toContain("Path=/api/auth");
      expect(cleared.raw).toContain("HttpOnly");
      expect(cleared.raw).toMatch(/Expires=Thu, 01 Jan 1970/);

      expect(
        (await Session.findById(aliceDevice2.sessionId).exec())?.revokedAt,
      ).toBeInstanceOf(Date);

      const audits = await auditsOf(alice.userId, "USER_LOGOUT");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.resourceId?.toString()).toBe(aliceDevice2.sessionId);
      expect(audits[0]?.organizationId.toString()).toBe(alice.organizationId);

      const reuse = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${aliceDevice2.refreshToken}`);

      expect(reuse.status).toBe(401);
      expect(reuse.body).toEqual(genericRefreshError);

      expect(await activeSessionsOf(alice.userId)).toHaveLength(0);
    });

    // ===================================================================
    // 8. Forgot password
    // ===================================================================
    let resetToken = "";
    let aliceBeforeReset: LoggedIn;

    await step("8. Forgot password", async () => {
      // A live session, so the reset has something to revoke.
      aliceBeforeReset = await loginAs(alice, alice.password);

      const known = await request(app)
        .post("/api/auth/forgot-password")
        .set("User-Agent", AGENT)
        .send({ email: alice.email });
      const unknownEmail = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: "nobody-at-all@example.com" });

      expect(known.status).toBe(200);
      expect(known.body.success).toBe(true);
      expect(unknownEmail.status).toBe(200);
      // The response does not reveal that the account exists.
      expect(known.body).toEqual(unknownEmail.body);

      expect(sendReset).toHaveBeenCalledTimes(1);
      expect(sendReset.mock.calls[0]?.[0]).toBe(alice.email);

      resetToken = tokenFromEmail(sendReset.mock.calls[0]?.[1]);
      rawTokens.push(resetToken);

      // Stored hashed, with the 30-minute TTL; never raw.
      const key = `auth:password-reset:${hashToken(resetToken)}`;
      expect(JSON.parse((await redisClient.get(key)) ?? "{}")).toEqual({
        userId: alice.userId,
        organizationId: alice.organizationId,
      });

      const ttl = await redisClient.ttl(key);
      expect(ttl).toBeGreaterThan(
        AUTH_CONSTANTS.PASSWORD_RESET_TOKEN_TTL_SECONDS - 30,
      );
      expect(ttl).toBeLessThanOrEqual(
        AUTH_CONSTANTS.PASSWORD_RESET_TOKEN_TTL_SECONDS,
      );

      for (const redisKey of await redisClient.keys("*")) {
        expect(redisKey).not.toContain(resetToken);
      }

      for (const value of await Promise.all(
        (await redisClient.keys("auth:*")).map(
          async (k) => (await redisClient.get(k).catch(() => null)) ?? "",
        ),
      )) {
        expect(value).not.toContain(resetToken);
      }

      // Audit only for the real account.
      const audits = await AuditLog.find({
        action: "PASSWORD_RESET_REQUESTED",
      }).exec();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.userId.toString()).toBe(alice.userId);

      scanForSecrets("forgot-password response", known.text + unknownEmail.text);
    });

    // ===================================================================
    // 9. Reset password
    // ===================================================================
    const resetPassword = "Alice-Reset-Passw0rd!";
    let resetChangedAt: Date | undefined;

    await step("9. Reset password", async () => {
      passwords.push(resetPassword);

      const hashBefore = await hashOf(alice.userId);
      const activeBefore = (await activeSessionsOf(alice.userId)).length;
      expect(activeBefore).toBe(1);

      const bobSessionsBefore = await loginAs(bob, bob.password);

      const res = await request(app)
        .post("/api/auth/reset-password")
        .set("User-Agent", AGENT)
        .send({ token: resetToken, newPassword: resetPassword });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      scanForSecrets("reset response", res.text);
      expectNoInternals(res.body);

      const user = await User.findById(alice.userId)
        .select("+passwordHash")
        .exec();
      const hashAfter = await hashOf(alice.userId);

      expect(hashAfter).not.toBe(hashBefore);
      expect(hashAfter).toMatch(/^\$argon2/);
      expect(user?.passwordChangedAt).toBeInstanceOf(Date);
      resetChangedAt = user?.passwordChangedAt ?? undefined;

      // All sessions revoked; the old refresh token is dead.
      expect(await activeSessionsOf(alice.userId)).toHaveLength(0);

      const refreshAfter = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${aliceBeforeReset.refreshToken}`);
      expect(refreshAfter.status).toBe(401);

      // The token is single use.
      expect(
        await redisClient.exists(
          `auth:password-reset:${hashToken(resetToken)}`,
        ),
      ).toBe(0);

      const reused = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: resetToken, newPassword: "Another-Passw0rd-99!" });

      expect(reused.status).toBe(400);
      expectStandardError(reused.body as ErrorBody, "INVALID_OR_EXPIRED_TOKEN");

      // Audit.
      const audits = await auditsOf(alice.userId, "PASSWORD_RESET_COMPLETED");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toEqual({ revokedSessionCount: 1 });
      expect(audits[0]?.organizationId.toString()).toBe(alice.organizationId);

      // Another tenant's session is untouched.
      expect(
        (await Session.findById(bobSessionsBefore.sessionId).exec())
          ?.revokedAt ?? null,
      ).toBeNull();
    });

    // ===================================================================
    // 10. Login after reset
    // ===================================================================
    let aliceAfterReset: LoggedIn;

    await step("10. Login after reset", async () => {
      const oldPassword = await request(app)
        .post("/api/auth/login")
        .send({ email: alice.email, password: alice.password });

      expect(oldPassword.status).toBe(401);
      expectStandardError(oldPassword.body as ErrorBody, "INVALID_CREDENTIALS");
      expect(oldPassword.headers["set-cookie"]).toBeUndefined();

      const loginsBefore = (await auditsOf(alice.userId, "USER_LOGIN")).length;

      aliceAfterReset = await loginAs(alice, resetPassword);

      const cookie = refreshCookie(aliceAfterReset.response.headers);
      expect(cookie.raw).toContain("HttpOnly");
      expect(aliceAfterReset.response.text).not.toContain(
        aliceAfterReset.refreshToken,
      );

      expect(await activeSessionsOf(alice.userId)).toHaveLength(1);
      expect(
        (await auditsOf(alice.userId, "USER_LOGIN")).length,
      ).toBe(loginsBefore + 1);
    });

    // ===================================================================
    // 11. Change password
    // ===================================================================
    const changedPassword = "Alice-Changed-Passw0rd!";

    await step("11. Change password", async () => {
      passwords.push(changedPassword);

      const change = (body: Record<string, unknown>) =>
        request(app)
          .post("/api/auth/change-password")
          .set("Authorization", bearer(aliceAfterReset.accessToken))
          .set("User-Agent", AGENT)
          .send(body);

      const hashBefore = await hashOf(alice.userId);

      const wrong = await change({
        currentPassword: "Wrong-Current-Passw0rd!",
        newPassword: changedPassword,
      });
      expect(wrong.status).toBe(400);
      expectStandardError(wrong.body as ErrorBody, "INVALID_CURRENT_PASSWORD");

      const same = await change({
        currentPassword: resetPassword,
        newPassword: resetPassword,
      });
      expect(same.status).toBe(400);
      expectStandardError(same.body as ErrorBody, "PASSWORD_REUSE");

      // Failed attempts changed nothing.
      expect(await hashOf(alice.userId)).toBe(hashBefore);
      expect(await activeSessionsOf(alice.userId)).toHaveLength(1);
      expect(await auditsOf(alice.userId, "PASSWORD_CHANGED")).toHaveLength(0);

      const ok = await change({
        currentPassword: resetPassword,
        newPassword: changedPassword,
      });

      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        success: true,
        message: "Password changed successfully",
        data: {},
        meta: {},
      });
      scanForSecrets("change-password response", ok.text);

      // Current implementation: all sessions revoked, cookie cleared.
      expect(await activeSessionsOf(alice.userId)).toHaveLength(0);
      expect(refreshCookie(ok.headers).value).toBe("");

      const user = await User.findById(alice.userId).exec();
      expect(user?.passwordChangedAt?.getTime()).toBeGreaterThanOrEqual(
        resetChangedAt?.getTime() ?? 0,
      );
      expect(await hashOf(alice.userId)).not.toBe(hashBefore);

      const audits = await auditsOf(alice.userId, "PASSWORD_CHANGED");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toEqual({});
      expect(audits[0]?.organizationId.toString()).toBe(alice.organizationId);

      // Old password fails; the access token of a revoked session is
      // rejected at once (it is checked against its session).
      const stale = await request(app)
        .post("/api/auth/login")
        .send({ email: alice.email, password: resetPassword });
      expect(stale.status).toBe(401);

      const revokedToken = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(aliceAfterReset.accessToken));
      expect(revokedToken.status).toBe(401);
      expectStandardError(revokedToken.body as ErrorBody, "UNAUTHORIZED");
    });

    // ===================================================================
    // 12. Session management
    // ===================================================================
    let bobSession: LoggedIn;

    await step("12. Sessions", async () => {
      const a = await loginAs(alice, changedPassword);
      const b = await loginAs(alice, changedPassword);
      bobSession = await loginAs(bob, bob.password);

      // Lists only the caller's own sessions, flags the current one.
      const list = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(a.accessToken));

      expect(list.status).toBe(200);
      const listed = list.body.data.sessions as Array<{
        id: string;
        current: boolean;
      }>;
      expect(listed.map((s) => s.id).sort()).toEqual(
        [a.sessionId, b.sessionId].sort(),
      );
      expect(listed.find((s) => s.id === a.sessionId)?.current).toBe(true);
      expect(listed.find((s) => s.id === b.sessionId)?.current).toBe(false);
      expect(JSON.stringify(list.body)).not.toContain(bobSession.sessionId);

      // Another tenant's session cannot be revoked.
      const foreign = await request(app)
        .delete(`/api/auth/sessions/${bobSession.sessionId}`)
        .set("Authorization", bearer(a.accessToken));

      expect(foreign.status).toBe(404);
      expectStandardError(foreign.body as ErrorBody, "SESSION_NOT_FOUND");
      expect(
        (await Session.findById(bobSession.sessionId).exec())?.revokedAt ??
          null,
      ).toBeNull();

      // Revoking one of the caller's sessions affects only that one.
      const revokeOne = await request(app)
        .delete(`/api/auth/sessions/${b.sessionId}`)
        .set("Authorization", bearer(a.accessToken));

      expect(revokeOne.status).toBe(200);
      expect(
        (await Session.findById(b.sessionId).exec())?.revokedAt,
      ).toBeInstanceOf(Date);
      expect(
        (await Session.findById(a.sessionId).exec())?.revokedAt ?? null,
      ).toBeNull();
      // Revoking a DIFFERENT session must not clear the caller's cookie.
      expect(revokeOne.headers["set-cookie"]).toBeUndefined();

      // Revoke-all affects only the caller's sessions.
      const revokeAll = await request(app)
        .delete("/api/auth/sessions")
        .set("Authorization", bearer(a.accessToken));

      expect(revokeAll.status).toBe(200);
      expect(revokeAll.body.data.revokedCount).toBe(1);
      expect(await activeSessionsOf(alice.userId)).toHaveLength(0);
      expect(
        (await Session.findById(bobSession.sessionId).exec())?.revokedAt ??
          null,
      ).toBeNull();

      expect(
        await auditsOf(alice.userId, "SESSION_REVOKED"),
      ).toHaveLength(1);
      expect(
        await auditsOf(alice.userId, "SESSIONS_REVOKED_ALL"),
      ).toHaveLength(1);
    });

    // ===================================================================
    // 13. Account / organization status
    // ===================================================================
    // Bob's session that is active after step 13 (the original was rotated).
    let bobActiveSessionId = "";

    await step("13. Account and organization status", async () => {
      let bobRefresh = bobSession.refreshToken;
      const bobAccess = bobSession.accessToken;

      const cases: Array<{
        name: string;
        apply: () => Promise<unknown>;
        restore: () => Promise<unknown>;
      }> = [
        {
          name: "suspended user",
          apply: () =>
            User.updateOne({ _id: bob.userId }, { $set: { status: "SUSPENDED" } }),
          restore: () =>
            User.updateOne({ _id: bob.userId }, { $set: { status: "ACTIVE" } }),
        },
        {
          name: "deleted user",
          apply: () =>
            User.updateOne({ _id: bob.userId }, { $set: { status: "DELETED" } }),
          restore: () =>
            User.updateOne({ _id: bob.userId }, { $set: { status: "ACTIVE" } }),
        },
        {
          name: "suspended organization",
          apply: () =>
            Organization.updateOne(
              { _id: bob.organizationId },
              { $set: { status: "SUSPENDED" } },
            ),
          restore: () =>
            Organization.updateOne(
              { _id: bob.organizationId },
              { $set: { status: "ACTIVE" } },
            ),
        },
        {
          name: "deleted organization",
          apply: () =>
            Organization.updateOne(
              { _id: bob.organizationId },
              { $set: { status: "DELETED" } },
            ),
          restore: () =>
            Organization.updateOne(
              { _id: bob.organizationId },
              { $set: { status: "ACTIVE" } },
            ),
        },
      ];

      // Active account works (session route and the permission guard).
      expect(
        (
          await request(app)
            .get("/api/auth/sessions")
            .set("Authorization", bearer(bobAccess))
        ).status,
      ).toBe(200);

      expect(
        (
          await request(guarded)
            .post("/forms")
            .set("Authorization", bearer(bobAccess))
        ).status,
      ).toBe(200);

      for (const { name, apply, restore } of cases) {
        await apply();

        // Protected operations that enforce account status: refresh,
        // change-password and login. (Session routes intentionally do not;
        // that is the accepted decision from 8.15.7.)
        const refresh = await request(app)
          .post("/api/auth/refresh")
          .set("Cookie", `refreshToken=${bobRefresh}`);

        const change = await request(app)
          .post("/api/auth/change-password")
          .set("Authorization", bearer(bobAccess))
          .send({
            currentPassword: bob.password,
            newPassword: "Bob-Never-Applied-Passw0rd!",
          });

        const login = await request(app)
          .post("/api/auth/login")
          .send({ email: bob.email, password: bob.password });

        for (const [what, res] of [
          ["refresh", refresh],
          ["change-password", change],
          ["login", login],
        ] as const) {
          expect(res.status, `${name} / ${what}`).toBe(403);
          expectStandardError(res.body as ErrorBody, "ACCOUNT_NOT_ACTIVE");
          expectNoInternals(res.body);
          expect(res.headers["set-cookie"], `${name} / ${what}`).toBeUndefined();
        }

        // The permission guard (used by every future protected business
        // route) also refuses the still-valid JWT.
        const guardedCall = await request(guarded)
          .post("/forms")
          .set("Authorization", bearer(bobAccess));

        expect(guardedCall.status, `${name} / guard`).toBe(403);
        expectStandardError(guardedCall.body as ErrorBody, "ACCOUNT_NOT_ACTIVE");
        expect(guardedCall.body).toEqual(refresh.body);

        // No state leaked: same body whichever of user/org is inactive.
        expect(refresh.body).toEqual(login.body);

        await restore();
      }

      // Reactivation restores access through the guard too.
      expect(
        (
          await request(guarded)
            .post("/forms")
            .set("Authorization", bearer(bobAccess))
        ).status,
      ).toBe(200);

      // Reactivation restores access (and the untouched session).
      const refreshed = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${bobRefresh}`);

      expect(refreshed.status).toBe(200);
      bobRefresh = refreshCookie(refreshed.headers).value;
      refreshTokens.push(bobRefresh);

      const relogin = await loginAs(bob, bob.password);
      expect(relogin.response.status).toBe(200);
      bobActiveSessionId = relogin.sessionId;
    });

    // ===================================================================
    // 14. Tenant isolation and RBAC
    // ===================================================================
    await step("14. Tenant isolation", async () => {
      // A cannot authenticate as B.
      const crossLogin = await request(app)
        .post("/api/auth/login")
        .send({ email: bob.email, password: alice.password });
      expect(crossLogin.status).toBe(401);

      // A forged token pairing A's user with B's organization is refused.
      const forged = signAccessToken({
        userId: alice.userId,
        organizationId: bob.organizationId,
      });

      // Routes that load the account refuse it outright (401).
      const forgedChange = await request(app)
        .post("/api/auth/change-password")
        .set("Authorization", bearer(forged))
        .send({
          currentPassword: changedPassword,
          newPassword: "Whatever-Passw0rd-1!",
        });

      expect(forgedChange.status).toBe(401);
      expectStandardError(forgedChange.body as ErrorBody, "UNAUTHORIZED");

      // Session routes refuse it too: the token names no live session of
      // that user in that organization, so it never reaches B's data.
      const forgedList = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(forged));

      expect(forgedList.status).toBe(401);
      expectStandardError(forgedList.body as ErrorBody, "UNAUTHORIZED");
      expect(JSON.stringify(forgedList.body)).not.toContain(
        bobActiveSessionId,
      );

      const forgedRevoke = await request(app)
        .delete(`/api/auth/sessions/${bobActiveSessionId}`)
        .set("Authorization", bearer(forged));

      expect(forgedRevoke.status).toBe(401);
      expect(
        (await Session.findById(bobActiveSessionId).exec())?.revokedAt ??
          null,
      ).toBeNull();

      // Forged organizationId / userId do not change the auth context.
      const aliceLive = await loginAs(alice, changedPassword);

      const withForgedIds = await request(app)
        .get("/api/auth/sessions")
        .query({
          organizationId: bob.organizationId,
          userId: bob.userId,
        })
        .set("Authorization", bearer(aliceLive.accessToken))
        .set("X-Organization-Id", bob.organizationId)
        .set("X-User-Id", bob.userId);

      expect(withForgedIds.status).toBe(200);
      expect(
        withForgedIds.body.data.sessions.map((s: { id: string }) => s.id),
      ).toEqual([aliceLive.sessionId]);

      const forgedBody = await request(app)
        .post("/api/auth/change-password")
        .set("Authorization", bearer(aliceLive.accessToken))
        .send({
          organizationId: bob.organizationId,
          userId: bob.userId,
          currentPassword: changedPassword,
          newPassword: "Whatever-Passw0rd-1!",
        });
      expect(forgedBody.status).toBe(400);

      // Foreign role ids grant nothing; own role grants everything.
      const aliceRole = await Role.findOne({
        organizationId: alice.organizationId,
        name: "OWNER",
      }).exec();
      const bobRole = await Role.findOne({
        organizationId: bob.organizationId,
        name: "OWNER",
      }).exec();

      const context = {
        userId: alice.userId,
        organizationId: alice.organizationId,
        sessionId: aliceLive.sessionId,
      };

      await User.updateOne(
        { _id: alice.userId },
        { $set: { roleIds: [bobRole?._id] } },
      );

      expect(
        (await resolvePermissions(await loadActiveAccount(context))).size,
      ).toBe(0);

      await User.updateOne(
        { _id: alice.userId },
        { $set: { roleIds: [aliceRole?._id] } },
      );

      expect(
        [...(await resolvePermissions(await loadActiveAccount(context)))].sort(),
      ).toEqual([...OWNER_PERMISSIONS].sort());

      // RBAC through the real middleware chain (guarded app defined above).

      const asOwner = await request(guarded)
        .post("/forms")
        .set("Authorization", bearer(aliceLive.accessToken));
      expect(asOwner.status).toBe(200);

      // Bob's role is OWNER of Bob's org, but Alice cannot borrow it.
      await User.updateOne(
        { _id: alice.userId },
        { $set: { roleIds: [bobRole?._id] } },
      );

      const borrowed = await request(guarded)
        .post("/forms")
        .set("Authorization", bearer(aliceLive.accessToken))
        .send({ roleIds: [bobRole?._id], organizationId: bob.organizationId });
      expect(borrowed.status).toBe(403);
      expectStandardError(borrowed.body as ErrorBody, "FORBIDDEN");
      expect(JSON.stringify(borrowed.body)).not.toContain("form.create");

      await User.updateOne(
        { _id: alice.userId },
        { $set: { roleIds: [aliceRole?._id] } },
      );
    });

    // ===================================================================
    // 15. Audit verification
    // ===================================================================
    await step("15. Audit verification", async () => {
      const count = async (
        userId: string,
        action: string,
      ): Promise<number> => (await auditsOf(userId, action)).length;

      // Alice's trail.
      expect(await count(alice.userId, "USER_REGISTERED")).toBe(1);
      expect(await count(alice.userId, "USER_LOGIN")).toBe(
        alice.successfulLogins,
      );
      expect(await count(alice.userId, "USER_LOGOUT")).toBe(1);
      expect(await count(alice.userId, "PASSWORD_RESET_REQUESTED")).toBe(1);
      expect(await count(alice.userId, "PASSWORD_RESET_COMPLETED")).toBe(1);
      expect(await count(alice.userId, "PASSWORD_CHANGED")).toBe(1);
      expect(await count(alice.userId, "SESSION_REVOKED")).toBe(1);
      expect(await count(alice.userId, "SESSIONS_REVOKED_ALL")).toBe(1);

      // Bob's trail.
      expect(await count(bob.userId, "USER_REGISTERED")).toBe(1);
      expect(await count(bob.userId, "USER_LOGIN")).toBe(bob.successfulLogins);
      expect(await AuditLog.countDocuments({ userId: bob.userId })).toBe(
        1 + bob.successfulLogins,
      );

      // Tenant-correct: every record belongs to its user's organization.
      const audits = await AuditLog.find().lean().exec();
      const owners = new Map<string, string>([
        [alice.userId, alice.organizationId],
        [bob.userId, bob.organizationId],
      ]);

      for (const audit of audits) {
        expect(owners.get(audit.userId.toString())).toBe(
          audit.organizationId.toString(),
        );
        expect(audit.ipAddress).toBeTypeOf("string");
        expect(audit.userAgent).toBeTypeOf("string");
        expect(audit.createdAt).toBeInstanceOf(Date);
      }

      // No secret of any kind in any audit record.
      const dump = JSON.stringify(audits);

      scanForSecrets("audit log", dump);

      for (const token of accessTokens) {
        expect(dump).not.toContain(token);
      }

      for (const fragment of [
        "passwordHash",
        "refreshTokenHash",
        "tokenFamilyId",
        env.JWT_ACCESS_SECRET,
        env.JWT_REFRESH_SECRET,
        env.MONGO_URI,
        env.REDIS_URL,
        env.EMAIL_PASSWORD,
      ]) {
        expect(dump).not.toContain(fragment);
      }

      // Nor in any log line produced during the whole lifecycle.
      const logged = JSON.stringify(
        logSpies.flatMap((spy) => spy.mock.calls),
      );

      scanForSecrets("server logs", logged);

      for (const token of accessTokens) {
        expect(logged).not.toContain(token);
      }
    });

    // ===================================================================
    // 16. API safety
    // ===================================================================
    await step("16. API safety", async () => {
      // The story above made more than 20 login attempts from one IP, so
      // the (working) login limiter is now engaged. Rate limiting is
      // verified in security-rate-limiting.test.ts; clear the counters so
      // this step can exercise error safety.
      await resetRateLimits();

      const aliceLive = await loginAs(alice, changedPassword);
      const auth = bearer(aliceLive.accessToken);

      const failing: request.Response[] = [
        // Authentication failures.
        await request(app).get("/api/auth/sessions"),
        await request(app)
          .get("/api/auth/sessions")
          .set("Authorization", "Bearer garbage"),
        // Validation failures.
        await request(app).post("/api/auth/login").send({ email: { $ne: "" } }),
        await request(app)
          .post("/api/auth/change-password")
          .set("Authorization", auth)
          .send({ currentPassword: "x" }),
        await request(app).delete("/api/auth/sessions/not-an-id").set("Authorization", auth),
        // Authorization-style and not-found failures.
        await request(app)
          .delete(`/api/auth/sessions/${objectId()}`)
          .set("Authorization", auth),
        await request(app).get("/api/no-such-route"),
        // Malformed transport.
        await request(app)
          .post("/api/auth/login")
          .set("Content-Type", "application/json")
          .send("{bad"),
        await request(app).get("/api/auth/sessions/%E0%A4%A"),
      ];

      // Unexpected error: generic, no internals.
      const failure = vi
        .spyOn(User, "findOne")
        .mockImplementation(() => {
          throw new Error(
            `connect ECONNREFUSED ${env.MONGO_URI} secret=${changedPassword}`,
          );
        });

      const unexpected = await request(app)
        .post("/api/auth/login")
        .send({ email: alice.email, password: changedPassword });

      failure.mockRestore();

      expect(unexpected.status).toBe(500);
      expect(unexpected.body.error.message).toBe(
        "An unexpected error occurred",
      );

      for (const res of [...failing, unexpected]) {
        expect(res.headers["content-type"]).toContain("application/json");
        expectStandardError(res.body as ErrorBody);
        expectNoInternals(res.body);
        scanForSecrets("error response", res.text);
        expect(res.headers["x-powered-by"]).toBeUndefined();
      }

      for (const res of failing) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }

      // The final lifecycle login is also audited, so re-check the total.
      expect(
        await AuditLog.countDocuments({
          userId: alice.userId,
          action: "USER_LOGIN",
        }),
      ).toBe(alice.successfulLogins);
    });

    expect(completedSteps).toHaveLength(16);
    void mongoose;
  }, 180_000);
});
