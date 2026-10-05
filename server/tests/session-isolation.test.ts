import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  getSessionFromDb,
} from "./helpers.js";

/*
 * 8.12.5 - cross-user / cross-tenant isolation.
 *
 * Complements session-management.test.ts with the reverse (B attacks A)
 * scenarios, revoke-all with several sessions per user, and proof that
 * client-supplied userId / organizationId never decide ownership.
 */

const sessionIds = (body: {
  data: { sessions: { id: string }[] };
}): string[] => body.data.sessions.map((session) => session.id);

describe("session isolation (8.12.5)", () => {
  it("user A cannot revoke user B's session, in either direction (same org)", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser({
      organizationId: userA.organizationId,
    });

    const a = await createTestSession(userA);
    const b = await createTestSession(userB);

    const aAttacksB = await request(app)
      .delete(`/api/auth/sessions/${b.sessionId}`)
      .set("Authorization", bearer(a.accessToken));

    const bAttacksA = await request(app)
      .delete(`/api/auth/sessions/${a.sessionId}`)
      .set("Authorization", bearer(b.accessToken));

    expect(aAttacksB.status).toBe(404);
    expect(aAttacksB.body.error.code).toBe("SESSION_NOT_FOUND");
    expect(bAttacksA.status).toBe(404);
    expect(bAttacksA.body.error.code).toBe("SESSION_NOT_FOUND");

    expect(
      (await getSessionFromDb(a.sessionId))?.revokedAt ?? null,
    ).toBeNull();
    expect(
      (await getSessionFromDb(b.sessionId))?.revokedAt ?? null,
    ).toBeNull();
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("cross-tenant: neither organization can revoke the other's session", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a = await createTestSession(userA);
    const b = await createTestSession(userB);

    const aAttacksB = await request(app)
      .delete(`/api/auth/sessions/${b.sessionId}`)
      .set("Authorization", bearer(a.accessToken));

    const bAttacksA = await request(app)
      .delete(`/api/auth/sessions/${a.sessionId}`)
      .set("Authorization", bearer(b.accessToken));

    expect(aAttacksB.status).toBe(404);
    expect(bAttacksA.status).toBe(404);

    expect(
      (await getSessionFromDb(a.sessionId))?.revokedAt ?? null,
    ).toBeNull();
    expect(
      (await getSessionFromDb(b.sessionId))?.revokedAt ?? null,
    ).toBeNull();
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("lists each user's own sessions only, in both directions", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a1 = await createTestSession(userA);
    const a2 = await createTestSession(userA);
    const b1 = await createTestSession(userB);
    const b2 = await createTestSession(userB);

    const listA = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(a1.accessToken));

    const listB = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer(b1.accessToken));

    expect(listA.status).toBe(200);
    expect(listB.status).toBe(200);
    expect(sessionIds(listA.body).sort()).toEqual(
      [a1.sessionId, a2.sessionId].sort(),
    );
    expect(sessionIds(listB.body).sort()).toEqual(
      [b1.sessionId, b2.sessionId].sort(),
    );
  });

  it("revoke-all only affects the caller when other users have several sessions", async () => {
    const userA = await createTestUser();
    const sameOrgUserB = await createTestUser({
      organizationId: userA.organizationId,
    });
    const otherOrgUserC = await createTestUser();

    const aSessions = [
      await createTestSession(userA),
      await createTestSession(userA),
      await createTestSession(userA),
    ];
    const bSessions = [
      await createTestSession(sameOrgUserB),
      await createTestSession(sameOrgUserB),
    ];
    const cSessions = [
      await createTestSession(otherOrgUserC),
      await createTestSession(otherOrgUserC),
    ];

    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", bearer(aSessions[0]!.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.revokedCount).toBe(3);

    for (const session of aSessions) {
      expect(
        (await getSessionFromDb(session.sessionId))?.revokedAt,
      ).toBeInstanceOf(Date);
    }

    for (const session of [...bSessions, ...cSessions]) {
      expect(
        (await getSessionFromDb(session.sessionId))?.revokedAt ??
          null,
      ).toBeNull();
    }

    const audits = await AuditLog.find({
      action: "SESSIONS_REVOKED_ALL",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId.toString()).toBe(userA.userId);
  });

  it("revoke-all ignores a userId / organizationId supplied by the client", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a = await createTestSession(userA);
    const b = await createTestSession(userB);

    const res = await request(app)
      .delete("/api/auth/sessions")
      .query({
        userId: userB.userId,
        organizationId: userB.organizationId,
      })
      .set("Authorization", bearer(a.accessToken))
      .send({
        userId: userB.userId,
        organizationId: userB.organizationId,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.revokedCount).toBe(1);

    expect(
      (await getSessionFromDb(a.sessionId))?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      (await getSessionFromDb(b.sessionId))?.revokedAt ?? null,
    ).toBeNull();
  });

  it("revoke-one ignores a userId / organizationId supplied by the client", async () => {
    const userA = await createTestUser();
    const userB = await createTestUser();

    const a = await createTestSession(userA);
    const b = await createTestSession(userB);

    const res = await request(app)
      .delete(`/api/auth/sessions/${b.sessionId}`)
      .query({
        userId: userB.userId,
        organizationId: userB.organizationId,
      })
      .set("Authorization", bearer(a.accessToken))
      .send({
        userId: userB.userId,
        organizationId: userB.organizationId,
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SESSION_NOT_FOUND");

    expect(
      (await getSessionFromDb(b.sessionId))?.revokedAt ?? null,
    ).toBeNull();
  });

  it("list ignores a userId / organizationId supplied by the client", async () => {
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

    expect(res.status).toBe(200);
    expect(sessionIds(res.body)).toEqual([a.sessionId]);
    expect(sessionIds(res.body)).not.toContain(b.sessionId);
  });
});
