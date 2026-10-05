import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Organization } from "../src/models/organization.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import { createPasswordResetCooldownKey } from "../src/repositories/password-reset-token.repository.js";
import * as emailService from "../src/services/email.service.js";
import { hashToken } from "../src/utils/token.util.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  getSessionFromDb,
  TEST_PASSWORD,
} from "./helpers.js";

vi.mock("../src/services/email.service.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/services/email.service.js")
    >();

  return {
    ...original,
    sendPasswordResetEmail: vi.fn(),
    sendPasswordChangedEmail: vi.fn(),
  };
});

const NEW_PASSWORD = "Brand-New-Passw0rd!";
const GENERIC_FORGOT_MESSAGE =
  "If an account with that email exists, a password reset email has been sent.";

const sendResetMock = vi.mocked(emailService.sendPasswordResetEmail);
const sendChangedMock = vi.mocked(emailService.sendPasswordChangedEmail);

const tokenKey = (rawToken: string): string =>
  `auth:password-reset:${hashToken(rawToken)}`;

const forgot = (email: string) =>
  request(app).post("/api/auth/forgot-password").send({ email });

const reset = (token: string, newPassword: string = NEW_PASSWORD) =>
  request(app)
    .post("/api/auth/reset-password")
    .send({ token, newPassword });

/*
 * The raw token only ever exists in the emailed URL, so tests read it
 * from the arguments of the mocked email sender.
 */
const lastEmailedToken = (): string => {
  const calls = sendResetMock.mock.calls;
  const lastCall = calls[calls.length - 1];

  if (!lastCall) {
    throw new Error("No password reset email was sent");
  }

  const token = new URL(lastCall[1]).searchParams.get("token");

  if (!token) {
    throw new Error("Reset URL has no token");
  }

  return token;
};

const clearCooldown = async (email: string): Promise<void> => {
  await redisClient.del(createPasswordResetCooldownKey(email));
};

beforeEach(() => {
  sendResetMock.mockReset();
  sendChangedMock.mockReset();
});

describe("POST /api/auth/forgot-password", () => {
  it("sends a reset email for an eligible account", async () => {
    const user = await createTestUser();

    const res = await forgot(user.email);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: GENERIC_FORGOT_MESSAGE,
    });

    expect(sendResetMock).toHaveBeenCalledTimes(1);
    expect(sendResetMock.mock.calls[0]?.[0]).toBe(user.email);

    const url = new URL(sendResetMock.mock.calls[0]![1]);
    expect(url.pathname).toBe("/reset-password");
    expect(lastEmailedToken()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an identical response for unknown and known emails", async () => {
    const user = await createTestUser();

    const known = await forgot(user.email);
    const unknown = await forgot("nobody-here@example.com");

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(sendResetMock).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for unverified, suspended, deleted or inactive-org accounts", async () => {
    const unverified = await createTestUser();
    await User.updateOne(
      { _id: unverified.userId },
      { $set: { emailVerified: false } },
    );

    const suspended = await createTestUser();
    await User.updateOne(
      { _id: suspended.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const deleted = await createTestUser();
    await User.updateOne(
      { _id: deleted.userId },
      { $set: { status: "DELETED" } },
    );

    const inactiveOrg = await createTestUser();
    await Organization.updateOne(
      { _id: inactiveOrg.organizationId },
      { $set: { status: "SUSPENDED" } },
    );

    const responses = [];

    for (const account of [
      unverified,
      suspended,
      deleted,
      inactiveOrg,
    ]) {
      responses.push(await forgot(account.email));
    }

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.message).toBe(GENERIC_FORGOT_MESSAGE);
    }

    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("normalizes the email like login does", async () => {
    const user = await createTestUser();

    const res = await forgot(`  ${user.email.toUpperCase()}  `);

    expect(res.status).toBe(200);
    expect(sendResetMock).toHaveBeenCalledTimes(1);
  });

  it("never stores the raw token in Redis or MongoDB", async () => {
    const user = await createTestUser();

    await forgot(user.email);

    const raw = lastEmailedToken();

    const keys = await redisClient.keys("auth:password-reset*");
    expect(keys).toContain(tokenKey(raw));

    for (const key of await redisClient.keys("*")) {
      expect(key).not.toContain(raw);

      const value = await redisClient.get(key).catch(() => null);
      expect(value ?? "").not.toContain(raw);
    }

    const audits = await AuditLog.find().lean().exec();
    expect(JSON.stringify(audits)).not.toContain(raw);
    expect(JSON.stringify(audits)).not.toContain(hashToken(raw));

    const stored = await User.findById(user.userId)
      .select("+passwordHash")
      .lean()
      .exec();
    expect(JSON.stringify(stored)).not.toContain(raw);
  });

  it("gives the token a 30-minute lifetime", async () => {
    const user = await createTestUser();

    await forgot(user.email);

    const ttl = await redisClient.ttl(tokenKey(lastEmailedToken()));

    expect(ttl).toBeGreaterThan(30 * 60 - 10);
    expect(ttl).toBeLessThanOrEqual(30 * 60);
  });

  it("writes a PASSWORD_RESET_REQUESTED audit record without secrets", async () => {
    const user = await createTestUser();

    await request(app)
      .post("/api/auth/forgot-password")
      .set("User-Agent", "vitest-agent")
      .send({ email: user.email });

    const audits = await AuditLog.find({
      action: "PASSWORD_RESET_REQUESTED",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(user.userId);
    expect(audits[0]?.organizationId.toString()).toBe(
      user.organizationId,
    );
    expect(audits[0]?.userAgent).toBe("vitest-agent");
    expect(audits[0]?.metadata).toEqual({});
  });

  it("writes no audit record for an unknown email", async () => {
    await forgot("nobody-here@example.com");

    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("applies a 60-second per-email cooldown", async () => {
    const user = await createTestUser();

    const first = await forgot(user.email);
    const second = await forgot(user.email);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(sendResetMock).toHaveBeenCalledTimes(1);

    const ttl = await redisClient.ttl(
      createPasswordResetCooldownKey(user.email),
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("invalidates the previous link when a new one is requested", async () => {
    const user = await createTestUser();

    await forgot(user.email);
    const firstToken = lastEmailedToken();

    await clearCooldown(user.email);

    await forgot(user.email);
    const secondToken = lastEmailedToken();

    expect(secondToken).not.toBe(firstToken);

    const stale = await reset(firstToken);
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");

    const fresh = await reset(secondToken);
    expect(fresh.status).toBe(200);
  });

  it("rate-limits requests per email", async () => {
    const user = await createTestUser();

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await clearCooldown(user.email);
      statuses.push((await forgot(user.email)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("rate-limits requests per IP, including for unknown emails", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (await forgot(`unknown-${attempt}@example.com`)).status,
      );
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("returns the generic 200 and sends nothing when Redis cannot store the token", async () => {
    const user = await createTestUser();

    const multi = vi
      .spyOn(redisClient, "multi")
      .mockImplementationOnce(() => {
        throw new Error("redis down");
      });

    const res = await forgot(user.email);
    multi.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC_FORGOT_MESSAGE);
    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("returns the generic 200 when the cooldown check hits a Redis error", async () => {
    const user = await createTestUser();

    const set = vi
      .spyOn(redisClient, "set")
      .mockRejectedValueOnce(new Error("redis down"));

    const res = await forgot(user.email);
    set.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC_FORGOT_MESSAGE);
    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("returns the generic 200 and leaves no token when the email fails to send", async () => {
    const user = await createTestUser();

    sendResetMock.mockRejectedValueOnce(new Error("smtp down"));

    const res = await forgot(user.email);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(GENERIC_FORGOT_MESSAGE);
    expect(
      await redisClient.keys("auth:password-reset:*"),
    ).toHaveLength(0);
    expect(
      await redisClient.keys("auth:password-reset-user:*"),
    ).toHaveLength(0);
  });

  it("rejects an invalid email with a validation error", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects extra fields such as organizationId", async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: user.email, organizationId: user.organizationId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(sendResetMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reset-password", () => {
  const requestToken = async (email: string): Promise<string> => {
    await forgot(email);
    return lastEmailedToken();
  };

  it("resets the password; the old one stops working and the new one works", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const res = await reset(token);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(oldLogin.status).toBeGreaterThanOrEqual(400);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.data.accessToken).toBeTypeOf("string");
  });

  it("stores an Argon2 hash and sets passwordChangedAt", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const before = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    await reset(token);

    const after = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).toMatch(/^\$argon2/);
    expect(after?.passwordHash).not.toContain(NEW_PASSWORD);
    expect(after?.passwordChangedAt).toBeInstanceOf(Date);
    expect(before?.passwordChangedAt ?? null).toBeNull();
  });

  it("makes the token one-time use", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const first = await reset(token);
    const second = await reset(token, "Another-Passw0rd!!");

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");

    // The second attempt must not have changed the password again.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    expect(await redisClient.exists(tokenKey(token))).toBe(0);
    expect(
      await redisClient.keys("auth:password-reset-user:*"),
    ).toHaveLength(0);
  });

  it("lets only one of two concurrent resets win", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const [a, b] = await Promise.all([
      reset(token, "Concurrent-Passw0rd-A"),
      reset(token, "Concurrent-Passw0rd-B"),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(
      await AuditLog.countDocuments({
        action: "PASSWORD_RESET_COMPLETED",
      }),
    ).toBe(1);
  });

  it("rejects an expired token", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    await redisClient.pExpire(tokenKey(token), 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await reset(token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("rejects an unknown but well-formed token with the same error as an expired one", async () => {
    const res = await reset("a".repeat(64));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
  });

  it("validates the token format, password policy and unknown fields", async () => {
    const badToken = await reset("short");
    expect(badToken.status).toBe(400);
    expect(badToken.body.error.code).toBe("VALIDATION_ERROR");

    const user = await createTestUser();
    const token = await requestToken(user.email);

    const weak = await reset(token, "short");
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");
    expect(weak.body.error.fields.newPassword).toBeTypeOf("string");

    // A rejected request must not have consumed the token.
    expect(await redisClient.exists(tokenKey(token))).toBe(1);

    const extra = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: NEW_PASSWORD, userId: user.userId });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects the current password and keeps the token usable", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const same = await reset(token, TEST_PASSWORD);

    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe("PASSWORD_REUSE");
    expect(JSON.stringify(same.body)).not.toContain(TEST_PASSWORD);

    const retry = await reset(token);
    expect(retry.status).toBe(200);
  });

  it("returns the generic error and burns the token for a suspended user", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const res = await reset(token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
    expect(await redisClient.exists(tokenKey(token))).toBe(0);

    // Re-activating the user must not resurrect the burned token.
    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "ACTIVE" } },
    );

    const retry = await reset(token);
    expect(retry.status).toBe(400);
  });

  it("returns the generic error and burns the token when the user no longer exists", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    await User.deleteOne({ _id: user.userId });

    const res = await reset(token);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_OR_EXPIRED_TOKEN");
    expect(await redisClient.exists(tokenKey(token))).toBe(0);
  });

  it("revokes all of the user's sessions and leaves other users' sessions alone", async () => {
    const user = await createTestUser();
    const sameOrgOther = await createTestUser({
      organizationId: user.organizationId,
    });
    const otherOrg = await createTestUser();

    const s1 = await createTestSession(user);
    const s2 = await createTestSession(user);
    const peer = await createTestSession(sameOrgOther);
    const stranger = await createTestSession(otherOrg);

    const token = await requestToken(user.email);
    const res = await reset(token);

    expect(res.status).toBe(200);

    for (const session of [s1, s2]) {
      expect(
        (await getSessionFromDb(session.sessionId))?.revokedAt,
      ).toBeInstanceOf(Date);
    }

    for (const session of [peer, stranger]) {
      expect(
        (await getSessionFromDb(session.sessionId))?.revokedAt ??
          null,
      ).toBeNull();
    }

    // Revoked, not deleted.
    expect(
      await Session.countDocuments({ userId: user.userId }),
    ).toBe(2);

    // Revoked refresh tokens can no longer be exchanged.
    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${s1.refreshToken}`);
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    expect(refresh.body.data?.accessToken).toBeUndefined();

    // Other users' sessions still work.
    const list = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(peer.accessToken));
    expect(list.status).toBe(200);
  });

  it("writes a PASSWORD_RESET_COMPLETED audit record without secrets", async () => {
    const user = await createTestUser();
    await createTestSession(user);
    await createTestSession(user);

    const token = await requestToken(user.email);

    await request(app)
      .post("/api/auth/reset-password")
      .set("User-Agent", "vitest-agent")
      .send({ token, newPassword: NEW_PASSWORD });

    const audits = await AuditLog.find({
      action: "PASSWORD_RESET_COMPLETED",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(user.userId);
    expect(audits[0]?.organizationId.toString()).toBe(
      user.organizationId,
    );
    expect(audits[0]?.resourceType).toBe("USER");
    expect(audits[0]?.resourceId?.toString()).toBe(user.userId);
    expect(audits[0]?.userAgent).toBe("vitest-agent");
    expect(audits[0]?.metadata).toEqual({ revokedSessionCount: 2 });

    const raw = JSON.stringify(await AuditLog.find().lean().exec());
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(hashToken(token));
    expect(raw).not.toContain(NEW_PASSWORD);
  });

  it("sends a confirmation email, and a failure there does not fail the reset", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    sendChangedMock.mockRejectedValueOnce(new Error("smtp down"));

    const res = await reset(token);

    expect(res.status).toBe(200);
    expect(sendChangedMock).toHaveBeenCalledWith(user.email);
  });

  it("returns 503 when Redis is unavailable", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const get = vi
      .spyOn(redisClient, "get")
      .mockRejectedValueOnce(new Error("redis down"));

    const res = await reset(token);
    get.mockRestore();

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain("redis down");
  });

  it("rate-limits reset attempts per IP", async () => {
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await reset("b".repeat(64))).status);
    }

    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(
      true,
    );
    expect(statuses[10]).toBe(429);
  });

  it("does not expose a token, hash or password in any response", async () => {
    const user = await createTestUser();
    const token = await requestToken(user.email);

    const res = await reset(token);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(token);
    expect(body).not.toContain(hashToken(token));
    expect(body).not.toContain(NEW_PASSWORD);
    expect(body).not.toContain("passwordHash");
  });
});

describe("User email uniqueness", () => {
  it("enforces a global unique index on email", async () => {
    const indexes = await User.collection.indexes();
    const emailIndex = indexes.find(
      (index) => index.name === "email_1",
    );

    expect(emailIndex?.unique).toBe(true);

    const first = await createTestUser();

    await expect(
      User.create({
        organizationId: (await createTestUser()).organizationId,
        firstName: "Dup",
        lastName: "User",
        email: first.email,
        passwordHash: "x",
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
