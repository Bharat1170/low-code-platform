import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Organization } from "../src/models/organization.model.js";
import { User } from "../src/models/user.model.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  getSessionFromDb,
  getSetCookies,
  isRefreshCookieCleared,
  TEST_PASSWORD,
  type TestSession,
  type TestUser,
} from "./helpers.js";

const NEW_PASSWORD = "Brand-New-Passw0rd!";

const change = (
  session: TestSession,
  body: Record<string, unknown>,
) =>
  request(app)
    .post("/api/auth/change-password")
    .set("Authorization", bearer(session.accessToken))
    .send(body);

const getHash = async (userId: string): Promise<string> => {
  const user = await User.findById(userId)
    .select("+passwordHash")
    .exec();

  return user?.passwordHash ?? "";
};

const login = (email: string, password: string) =>
  request(app).post("/api/auth/login").send({ email, password });

const isActive = async (sessionId: string): Promise<boolean> => {
  const session = await getSessionFromDb(sessionId);

  return (session?.revokedAt ?? null) === null;
};

const setup = async (): Promise<{
  user: TestUser;
  session: TestSession;
}> => {
  const user = await createTestUser();
  const session = await createTestSession(user);

  return { user, session };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/change-password", () => {
  it("changes the password and returns the standard success response", async () => {
    const { session } = await setup();

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "Password changed successfully",
      data: {},
      meta: {},
    });
  });

  it("updates passwordHash (Argon2) and passwordChangedAt", async () => {
    const { user, session } = await setup();

    const before = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const after = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).toMatch(/^\$argon2/);
    expect(after?.passwordHash).not.toContain(NEW_PASSWORD);
    expect(before?.passwordChangedAt ?? null).toBeNull();
    expect(after?.passwordChangedAt).toBeInstanceOf(Date);
  });

  it("makes the old password stop working and the new one work", async () => {
    const { user, session } = await setup();

    await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const oldLogin = await login(user.email, TEST_PASSWORD);
    expect(oldLogin.status).toBeGreaterThanOrEqual(400);

    const newLogin = await login(user.email, NEW_PASSWORD);
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.data.accessToken).toBeTypeOf("string");
  });

  it("revokes all of the user's active sessions, not other users' sessions", async () => {
    const { user, session } = await setup();
    const second = await createTestSession(user);
    const third = await createTestSession(user);

    const sameOrgPeer = await createTestUser({
      organizationId: user.organizationId,
    });
    const peerSession = await createTestSession(sameOrgPeer);

    const stranger = await createTestUser();
    const strangerSession = await createTestSession(stranger);

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);

    for (const revoked of [session, second, third]) {
      expect(await isActive(revoked.sessionId)).toBe(false);
    }

    for (const untouched of [peerSession, strangerSession]) {
      expect(await isActive(untouched.sessionId)).toBe(true);
    }

    // Revoked refresh tokens are unusable.
    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${second.refreshToken}`);

    expect(refresh.status).toBeGreaterThanOrEqual(400);
    expect(refresh.body.data?.accessToken).toBeUndefined();
  });

  it("clears the refresh cookie on success only", async () => {
    const { session } = await setup();

    const failure = await change(session, {
      currentPassword: "wrong-password-1",
      newPassword: NEW_PASSWORD,
    });

    expect(failure.status).toBe(400);
    expect(
      isRefreshCookieCleared(getSetCookies(failure.headers)),
    ).toBe(false);

    const success = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(success.status).toBe(200);
    expect(
      isRefreshCookieCleared(getSetCookies(success.headers)),
    ).toBe(true);
  });

  it("rejects already-issued access tokens once their sessions are revoked", async () => {
    const { session } = await setup();

    await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(session.accessToken));

    // The token is checked against its (now revoked) session.
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("writes a PASSWORD_CHANGED audit record without secrets", async () => {
    const { user, session } = await setup();

    await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(session.accessToken))
      .set("User-Agent", "vitest-agent")
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    const audits = await AuditLog.find({
      action: "PASSWORD_CHANGED",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(user.userId);
    expect(audits[0]?.organizationId.toString()).toBe(
      user.organizationId,
    );
    expect(audits[0]?.resourceType).toBe("USER");
    expect(audits[0]?.resourceId?.toString()).toBe(user.userId);
    expect(audits[0]?.userAgent).toBe("vitest-agent");
    expect(audits[0]?.metadata).toEqual({});

    const raw = JSON.stringify(await AuditLog.find().lean().exec());
    const hash = await getHash(user.userId);

    for (const secret of [
      TEST_PASSWORD,
      NEW_PASSWORD,
      hash,
      session.accessToken,
      session.refreshToken,
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("never returns passwords, hashes or tokens", async () => {
    const { user, session } = await setup();

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const body = JSON.stringify(res.body);
    const hash = await getHash(user.userId);

    for (const secret of [
      TEST_PASSWORD,
      NEW_PASSWORD,
      hash,
      "passwordHash",
      session.accessToken,
      session.refreshToken,
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it("never logs passwords, hashes or tokens", async () => {
    const { user, session } = await setup();

    const spies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "info"),
    ];

    await change(session, {
      currentPassword: "wrong-password-1",
      newPassword: NEW_PASSWORD,
    });
    await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    const logged = JSON.stringify(
      spies.flatMap((spy) => spy.mock.calls),
    );
    const hash = await getHash(user.userId);

    for (const secret of [
      TEST_PASSWORD,
      NEW_PASSWORD,
      "wrong-password-1",
      hash,
      session.refreshToken,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe("change-password validation", () => {
  const expectUnchanged = async (
    user: TestUser,
    session: TestSession,
    hashBefore: string,
  ) => {
    expect(await getHash(user.userId)).toBe(hashBefore);
    expect(await isActive(session.sessionId)).toBe(true);
    expect(await AuditLog.countDocuments()).toBe(0);
  };

  it("requires currentPassword", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    const res = await change(session, { newPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields.currentPassword).toBeTypeOf("string");
    await expectUnchanged(user, session, hashBefore);
  });

  it("requires newPassword", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields.newPassword).toBeTypeOf("string");
    await expectUnchanged(user, session, hashBefore);
  });

  it("rejects a weak newPassword using the shared policy", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    const tooShort = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: "short",
    });

    const tooLong = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: "x".repeat(129),
    });

    for (const res of [tooShort, tooLong]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.fields.newPassword).toBeTypeOf("string");
    }

    await expectUnchanged(user, session, hashBefore);
  });

  it("rejects non-string values", async () => {
    const { session } = await setup();

    const res = await change(session, {
      currentPassword: { $ne: "" },
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown fields (no mass assignment)", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    for (const extra of [
      { passwordHash: "injected" },
      { status: "ACTIVE" },
      { roleIds: [] },
      { emailVerified: true },
    ]) {
      const res = await change(session, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
        ...extra,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }

    await expectUnchanged(user, session, hashBefore);
  });

  it("rejects a wrong current password without changing anything", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    const res = await change(session, {
      currentPassword: "wrong-password-1",
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
    expect(JSON.stringify(res.body)).not.toContain(hashBefore);
    await expectUnchanged(user, session, hashBefore);
  });

  it("rejects a new password equal to the current one with PASSWORD_REUSE", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("PASSWORD_REUSE");
    expect(JSON.stringify(res.body)).not.toContain(TEST_PASSWORD);
    await expectUnchanged(user, session, hashBefore);
  });
});

describe("change-password authentication and isolation", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app)
      .post("/api/auth/change-password")
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a tampered access token", async () => {
    const { session } = await setup();

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${session.accessToken}x`)
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(401);
  });

  it("rejects a client-supplied userId and cannot change another user's password", async () => {
    const attacker = await setup();
    const victim = await setup();
    const victimHash = await getHash(victim.user.userId);

    const res = await change(attacker.session, {
      userId: victim.user.userId,
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await getHash(victim.user.userId)).toBe(victimHash);
    expect(await isActive(victim.session.sessionId)).toBe(true);
  });

  it("rejects a client-supplied organizationId", async () => {
    const attacker = await setup();
    const victim = await setup();
    const attackerHash = await getHash(attacker.user.userId);

    const res = await change(attacker.session, {
      organizationId: victim.user.organizationId,
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await getHash(attacker.user.userId)).toBe(attackerHash);
  });

  it("ignores userId / organizationId in the query string", async () => {
    const attacker = await setup();
    const victim = await setup();
    const victimHash = await getHash(victim.user.userId);

    const res = await request(app)
      .post("/api/auth/change-password")
      .query({
        userId: victim.user.userId,
        organizationId: victim.user.organizationId,
      })
      .set("Authorization", bearer(attacker.session.accessToken))
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    // Only the attacker's own password changes.
    expect(res.status).toBe(200);
    expect(await getHash(victim.user.userId)).toBe(victimHash);
    expect(await isActive(victim.session.sessionId)).toBe(true);
    expect(await isActive(attacker.session.sessionId)).toBe(false);

    const audits = await AuditLog.find({
      action: "PASSWORD_CHANGED",
    }).exec();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(attacker.user.userId);
  });

  it("only changes the authenticated user's password (cross-tenant)", async () => {
    const a = await setup();
    const b = await setup();
    const bHash = await getHash(b.user.userId);

    const res = await change(a.session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(await getHash(b.user.userId)).toBe(bHash);

    const bLogin = await login(b.user.email, TEST_PASSWORD);
    expect(bLogin.status).toBe(200);
  });

  it("rejects a token whose organizationId does not match the user", async () => {
    const user = await createTestUser();
    const otherOrg = await createTestUser();
    const hashBefore = await getHash(user.userId);

    const forged = await createTestSession({
      userId: user.userId,
      organizationId: otherOrg.organizationId,
      email: user.email,
    });

    const res = await change(forged, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(await getHash(user.userId)).toBe(hashBefore);
  });

  it("rejects a token for a user that no longer exists", async () => {
    const { user, session } = await setup();

    await User.deleteOne({ _id: user.userId });

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(401);
  });

  it("rejects an inactive user", async () => {
    for (const status of ["SUSPENDED", "DELETED"]) {
      const { user, session } = await setup();
      const hashBefore = await getHash(user.userId);

      await User.updateOne({ _id: user.userId }, { $set: { status } });

      const res = await change(session, {
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
      expect(await getHash(user.userId)).toBe(hashBefore);
      expect(await isActive(session.sessionId)).toBe(true);
    }
  });

  it("rejects an inactive organization", async () => {
    const { user, session } = await setup();
    const hashBefore = await getHash(user.userId);

    await Organization.updateOne(
      { _id: user.organizationId },
      { $set: { status: "SUSPENDED" } },
    );

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
    expect(await getHash(user.userId)).toBe(hashBefore);
    expect(await isActive(session.sessionId)).toBe(true);
  });
});

describe("change-password rate limiting and concurrency", () => {
  it("rate-limits per authenticated user", async () => {
    const { session } = await setup();

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (
          await change(session, {
            currentPassword: "wrong-password-1",
            newPassword: NEW_PASSWORD,
          })
        ).status,
      );
    }

    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("does not let one user's attempts block another user", async () => {
    const a = await setup();
    const b = await setup();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await change(a.session, {
        currentPassword: "wrong-password-1",
        newPassword: NEW_PASSWORD,
      });
    }

    const res = await change(b.session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
  });

  it("keys the limiter on the JWT user, so a forged body userId cannot reset it", async () => {
    const { session } = await setup();

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push(
        (
          await change(session, {
            userId: `${attempt}`.padStart(24, "0"),
            currentPassword: "wrong-password-1",
            newPassword: NEW_PASSWORD,
          })
        ).status,
      );
    }

    expect(statuses[5]).toBe(429);
  });

  it("returns 503 when Redis is unavailable (fails closed)", async () => {
    const { session } = await setup();

    // Every incr fails (the global limiter's store passes on errors; the
    // change-password limiter must not).
    vi.spyOn(redisClient, "incr").mockRejectedValue(new Error("redis down"));

    const res = await change(session, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("lets only one of two concurrent changes win", async () => {
    const { user, session } = await setup();
    const secondSession = await createTestSession(user);

    const [a, b] = await Promise.all([
      change(session, {
        currentPassword: TEST_PASSWORD,
        newPassword: "Concurrent-Passw0rd-A",
      }),
      change(secondSession, {
        currentPassword: TEST_PASSWORD,
        newPassword: "Concurrent-Passw0rd-B",
      }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe("PASSWORD_CHANGE_CONFLICT");

    expect(
      await AuditLog.countDocuments({ action: "PASSWORD_CHANGED" }),
    ).toBe(1);

    const winnerPassword =
      a.status === 200
        ? "Concurrent-Passw0rd-A"
        : "Concurrent-Passw0rd-B";
    const loserPassword =
      a.status === 200
        ? "Concurrent-Passw0rd-B"
        : "Concurrent-Passw0rd-A";

    expect((await login(user.email, winnerPassword)).status).toBe(200);
    expect(
      (await login(user.email, loserPassword)).status,
    ).toBeGreaterThanOrEqual(400);
  });
});
