import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Session } from "../src/models/session.model.js";
import { hashToken } from "../src/utils/token.util.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  getSessionFromDb,
  getSetCookies,
  isRefreshCookieCleared,
  objectId,
} from "./helpers.js";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;

describe("GET /api/auth/sessions", () => {
  // TEST 1
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/auth/sessions");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  // TEST 2
  it("returns only the authenticated user's sessions", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a1 = await createTestSession(userA);
    const a2 = await createTestSession(userA);
    const b1 = await createTestSession(userB);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(a1.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const ids = res.body.data.sessions.map(
      (session: { id: string }) => session.id,
    );

    expect(ids).toHaveLength(2);
    expect(ids).toContain(a1.sessionId);
    expect(ids).toContain(a2.sessionId);
    expect(ids).not.toContain(b1.sessionId);
  });

  // TEST 3
  it("identifies the current session from the JWT sessionId", async () => {
    const user = await createTestUser();

    const s1 = await createTestSession(user);
    const s2 = await createTestSession(user);

    const asS1 = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken));

    const currentForS1 = asS1.body.data.sessions.filter(
      (session: { current: boolean }) => session.current,
    );

    expect(currentForS1).toHaveLength(1);
    expect(currentForS1[0].id).toBe(s1.sessionId);

    const asS2 = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(s2.accessToken));

    const currentForS2 = asS2.body.data.sessions.filter(
      (session: { current: boolean }) => session.current,
    );

    expect(currentForS2).toHaveLength(1);
    expect(currentForS2[0].id).toBe(s2.sessionId);
  });

  it("does not use the refresh cookie to decide the current session", async () => {
    const user = await createTestUser();

    const s1 = await createTestSession(user);
    const s2 = await createTestSession(user);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken))
      .set("Cookie", `refreshToken=${s2.refreshToken}`);

    const current = res.body.data.sessions.filter(
      (session: { current: boolean }) => session.current,
    );

    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(s1.sessionId);
  });

  // TEST 4
  it("never exposes sensitive fields", async () => {
    const user = await createTestUser();
    const s1 = await createTestSession(user);
    await createTestSession(user);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken));

    expect(res.status).toBe(200);

    const stored = await Session.findById(s1.sessionId)
      .select("+refreshTokenHash")
      .exec();

    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain("refreshTokenHash");
    expect(raw).not.toContain("tokenFamilyId");
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain(s1.refreshToken);
    expect(raw).not.toContain(stored?.refreshTokenHash ?? "missing");
    expect(raw).not.toContain(stored?.tokenFamilyId ?? "missing");

    for (const session of res.body.data.sessions) {
      expect(Object.keys(session).sort()).toEqual([
        "createdAt",
        "current",
        "expiresAt",
        "id",
      ]);
    }
  });

  // TEST 14
  it("does not list expired sessions", async () => {
    const user = await createTestUser();
    const active = await createTestSession(user);
    const expired = await createTestSession(user);

    await Session.updateOne(
      { _id: expired.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(active.accessToken));

    const ids = res.body.data.sessions.map(
      (session: { id: string }) => session.id,
    );

    expect(ids).toEqual([active.sessionId]);
  });

  it("does not list revoked sessions", async () => {
    const user = await createTestUser();
    const active = await createTestSession(user);
    const revoked = await createTestSession(user);

    await Session.updateOne(
      { _id: revoked.sessionId },
      { $set: { revokedAt: new Date() } },
    );

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(active.accessToken));

    const ids = res.body.data.sessions.map(
      (session: { id: string }) => session.id,
    );

    expect(ids).toEqual([active.sessionId]);
  });

  it("ignores userId / organizationId supplied by the client", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a = await createTestSession(userA);
    const b = await createTestSession(userB);

    const res = await request(app)
      .get("/api/auth/sessions")
      .query({
        userId: userB.userId,
        organizationId: userB.organizationId,
      })
      .set("Authorization", bearer(a.accessToken));

    const ids = res.body.data.sessions.map(
      (session: { id: string }) => session.id,
    );

    expect(ids).toEqual([a.sessionId]);
    expect(ids).not.toContain(b.sessionId);
  });
});

describe("authentication middleware", () => {
  // TEST 15
  it("rejects a token signed with the wrong secret", async () => {
    const user = await createTestUser();

    const forged = jwt.sign(
      {
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "access",
      },
      "a-completely-different-secret-0123456789abcdef",
      { subject: user.userId, algorithm: "HS256" },
    );

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(forged));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a tampered token", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const [header, payload, signature] =
      session.accessToken.split(".");

    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: objectId(),
        organizationId: user.organizationId,
        sessionId: session.sessionId,
        type: "access",
      }),
    ).toString("base64url");

    const res = await request(app)
      .get("/api/auth/sessions")
      .set(
        "Authorization",
        bearer(`${header}.${tamperedPayload}.${signature}`),
      );

    expect(res.status).toBe(401);

    // Also: payload untouched but signature mangled.
    const res2 = await request(app)
      .get("/api/auth/sessions")
      .set(
        "Authorization",
        bearer(`${header}.${payload}.${signature}x`),
      );

    expect(res2.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const user = await createTestUser();

    const expired = jwt.sign(
      {
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "access",
      },
      ACCESS_SECRET,
      {
        subject: user.userId,
        algorithm: "HS256",
        expiresIn: -10,
      },
    );

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(expired));

    expect(res.status).toBe(401);
  });

  it("rejects a token that is not an access token", async () => {
    const user = await createTestUser();

    const wrongType = jwt.sign(
      {
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "refresh",
      },
      ACCESS_SECRET,
      { subject: user.userId, algorithm: "HS256" },
    );

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(wrongType));

    expect(res.status).toBe(401);
  });

  it("rejects an unsigned (alg none) token", async () => {
    const user = await createTestUser();

    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");

    const payload = Buffer.from(
      JSON.stringify({
        sub: user.userId,
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "access",
      }),
    ).toString("base64url");

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(`${header}.${payload}.`));

    expect(res.status).toBe(401);
  });

  it("rejects garbage in the bearer slot", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", "Bearer not-a-jwt");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  // TEST 16
  it("rejects a missing Authorization header", async () => {
    const res = await request(app).get("/api/auth/sessions");

    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer Authorization scheme", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Basic ${session.accessToken}`);

    expect(res.status).toBe(401);
  });

  it("does not leak JWT verification details", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", "Bearer not-a-jwt");

    const raw = JSON.stringify(res.body).toLowerCase();

    expect(raw).not.toContain("jwt");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain("malformed");
  });

  it("protects every session route", async () => {
    const del = await request(app).delete("/api/auth/sessions");
    const delOne = await request(app).delete(
      `/api/auth/sessions/${objectId()}`,
    );

    expect(del.status).toBe(401);
    expect(delOne.status).toBe(401);
  });
});

describe("DELETE /api/auth/sessions/:sessionId", () => {
  // TEST 5
  it("revokes another active session and writes an audit record", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);
    const other = await createTestSession(user);

    const res = await request(app)
      .delete(`/api/auth/sessions/${other.sessionId}`)
      .set("Authorization", bearer(current.accessToken))
      .set("User-Agent", "vitest-agent");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The current refresh cookie must NOT be cleared.
    expect(
      isRefreshCookieCleared(getSetCookies(res.headers)),
    ).toBe(false);

    const revoked = await getSessionFromDb(other.sessionId);
    const stillActive = await getSessionFromDb(current.sessionId);

    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(stillActive?.revokedAt ?? null).toBeNull();

    const audits = await AuditLog.find({
      action: "SESSION_REVOKED",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(user.userId);
    expect(audits[0]?.organizationId.toString()).toBe(
      user.organizationId,
    );
    expect(audits[0]?.resourceType).toBe("SESSION");
    expect(audits[0]?.resourceId?.toString()).toBe(
      other.sessionId,
    );
    expect(audits[0]?.userAgent).toBe("vitest-agent");
    expect(audits[0]?.metadata).toMatchObject({
      revokedSessionId: other.sessionId,
      revokedCurrentSession: false,
    });

    const list = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(current.accessToken));

    expect(
      list.body.data.sessions.map(
        (session: { id: string }) => session.id,
      ),
    ).toEqual([current.sessionId]);
  });

  // TEST 6
  it("revokes the current session, audits it and clears the refresh cookie", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);

    const res = await request(app)
      .delete(`/api/auth/sessions/${current.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    expect(res.status).toBe(200);
    expect(
      isRefreshCookieCleared(getSetCookies(res.headers)),
    ).toBe(true);

    const revoked = await getSessionFromDb(current.sessionId);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    const audits = await AuditLog.find({
      action: "SESSION_REVOKED",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({
      revokedCurrentSession: true,
    });
  });

  // TEST 7
  it("rejects an invalid session ID with a validation error", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .delete("/api/auth/sessions/not-an-object-id")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields.sessionId).toBeDefined();

    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("does not treat a NoSQL operator as a session ID", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .delete("/api/auth/sessions/%7B%22$ne%22:null%7D")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(400);

    const stillActive = await getSessionFromDb(session.sessionId);
    expect(stillActive?.revokedAt ?? null).toBeNull();
  });

  // TEST 8
  it("returns a safe 404 for a non-existent session", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .delete(`/api/auth/sessions/${objectId()}`)
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  // TEST 9
  it("prevents a user revoking another user's session (IDOR, same org)", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser({
      organizationId: userA.organizationId,
    });

    const a = await createTestSession(userA);
    const b = await createTestSession(userB);

    const attack = await request(app)
      .delete(`/api/auth/sessions/${a.sessionId}`)
      .set("Authorization", bearer(b.accessToken));

    const nonExistent = await request(app)
      .delete(`/api/auth/sessions/${objectId()}`)
      .set("Authorization", bearer(b.accessToken));

    expect(attack.status).toBe(404);
    expect(attack.body.error.code).toBe("SESSION_NOT_FOUND");

    // Identical response whether or not the session exists.
    expect(attack.body).toEqual(nonExistent.body);

    const untouched = await getSessionFromDb(a.sessionId);
    expect(untouched?.revokedAt ?? null).toBeNull();
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  // TEST 10
  it("prevents cross-tenant session revocation", async () => {
    const orgAUser = await createTestUser();
    const orgBUser = await createTestUser();

    const a = await createTestSession(orgAUser);
    const b = await createTestSession(orgBUser);

    const attack = await request(app)
      .delete(`/api/auth/sessions/${a.sessionId}`)
      .set("Authorization", bearer(b.accessToken));

    expect(attack.status).toBe(404);

    const untouched = await getSessionFromDb(a.sessionId);
    expect(untouched?.revokedAt ?? null).toBeNull();

    const list = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(b.accessToken));

    expect(
      list.body.data.sessions.map(
        (session: { id: string }) => session.id,
      ),
    ).toEqual([b.sessionId]);
  });

  it("scopes by organization even when the userId matches", async () => {
    const owner = await createTestUser();
    const victim = await createTestSession(owner);

    // Token for the same userId but a different organizationId.
    const otherOrg = await createTestUser();
    const forgedContext = await createTestSession({
      userId: owner.userId,
      organizationId: otherOrg.organizationId,
      email: owner.email,
    });

    const attack = await request(app)
      .delete(`/api/auth/sessions/${victim.sessionId}`)
      .set("Authorization", bearer(forgedContext.accessToken));

    expect(attack.status).toBe(404);

    const untouched = await getSessionFromDb(victim.sessionId);
    expect(untouched?.revokedAt ?? null).toBeNull();
  });

  // TEST 13
  it("does not revoke an already-revoked session twice", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);
    const other = await createTestSession(user);

    const first = await request(app)
      .delete(`/api/auth/sessions/${other.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    const firstRevokedAt = (
      await getSessionFromDb(other.sessionId)
    )?.revokedAt;

    const second = await request(app)
      .delete(`/api/auth/sessions/${other.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    const secondRevokedAt = (
      await getSessionFromDb(other.sessionId)
    )?.revokedAt;

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(secondRevokedAt?.getTime()).toBe(
      firstRevokedAt?.getTime(),
    );
    expect(
      await AuditLog.countDocuments({ action: "SESSION_REVOKED" }),
    ).toBe(1);
  });

  // TEST 14 (revoke side)
  it("treats an expired session as not found", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);
    const expired = await createTestSession(user);

    await Session.updateOne(
      { _id: expired.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await request(app)
      .delete(`/api/auth/sessions/${expired.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    expect(res.status).toBe(404);
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  // TEST 12
  it("prevents a revoked session from refreshing", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);
    const other = await createTestSession(user);

    const revoke = await request(app)
      .delete(`/api/auth/sessions/${other.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    expect(revoke.status).toBe(200);

    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${other.refreshToken}`);

    expect(refresh.status).toBeGreaterThanOrEqual(400);
    expect(refresh.body.success).toBe(false);
    expect(refresh.body.data?.accessToken).toBeUndefined();

    // The revoked token must not have produced a new session.
    const family = await Session.find({
      userId: user.userId,
      revokedAt: null,
    })
      .select("+refreshTokenHash")
      .exec();

    expect(
      family.some(
        (session) =>
          session.refreshTokenHash ===
          hashToken(other.refreshToken),
      ),
    ).toBe(false);
  });

  it("still allows a non-revoked session to refresh", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);
    const other = await createTestSession(user);

    await request(app)
      .delete(`/api/auth/sessions/${other.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    const refresh = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${current.refreshToken}`);

    expect(refresh.status).toBe(200);
    expect(refresh.body.data.accessToken).toBeTypeOf("string");
  });
});

describe("DELETE /api/auth/sessions", () => {
  // TEST 11
  it("revokes all of the user's active sessions", async () => {
    const user = await createTestUser();
    const other = await createTestUser();

    const s1 = await createTestSession(user);
    const s2 = await createTestSession(user);
    const s3 = await createTestSession(user);
    const otherSession = await createTestSession(other);

    // Already revoked sessions must not be counted.
    const alreadyRevoked = await createTestSession(user);
    await Session.updateOne(
      { _id: alreadyRevoked.sessionId },
      { $set: { revokedAt: new Date() } },
    );

    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken))
      .set("User-Agent", "vitest-agent");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.revokedCount).toBe(3);
    expect(
      isRefreshCookieCleared(getSetCookies(res.headers)),
    ).toBe(true);

    for (const session of [s1, s2, s3]) {
      const stored = await getSessionFromDb(session.sessionId);
      expect(stored?.revokedAt).toBeInstanceOf(Date);
    }

    // Another user's session is untouched.
    const untouched = await getSessionFromDb(
      otherSession.sessionId,
    );
    expect(untouched?.revokedAt ?? null).toBeNull();

    const audits = await AuditLog.find({
      action: "SESSIONS_REVOKED_ALL",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(user.userId);
    expect(audits[0]?.organizationId.toString()).toBe(
      user.organizationId,
    );
    expect(audits[0]?.resourceType).toBe("SESSION");
    expect(audits[0]?.resourceId ?? null).toBeNull();
    expect(audits[0]?.metadata).toMatchObject({ revokedCount: 3 });
  });

  it("only revokes sessions within the authenticated organization", async () => {
    const owner = await createTestUser();
    const ownerSession = await createTestSession(owner);

    const otherOrg = await createTestUser();
    const otherOrgContext = await createTestSession({
      userId: owner.userId,
      organizationId: otherOrg.organizationId,
      email: owner.email,
    });

    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", bearer(otherOrgContext.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.revokedCount).toBe(1);

    const untouched = await getSessionFromDb(
      ownerSession.sessionId,
    );
    expect(untouched?.revokedAt ?? null).toBeNull();
  });

  it("does not delete session documents", async () => {
    const user = await createTestUser();
    const s1 = await createTestSession(user);
    await createTestSession(user);

    await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken));

    expect(
      await Session.countDocuments({ userId: user.userId }),
    ).toBe(2);
  });

  it("rejects the token of a revoked session, without an audit record", async () => {
    const user = await createTestUser();
    const s1 = await createTestSession(user);

    await Session.updateOne(
      { _id: s1.sessionId },
      { $set: { revokedAt: new Date() } },
    );

    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(await AuditLog.countDocuments()).toBe(0);
  });
});
