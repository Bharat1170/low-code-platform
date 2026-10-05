import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Session } from "../src/models/session.model.js";
import * as auditRepository from "../src/repositories/audit-log.repository.js";

import {
  bearer,
  createTestSession,
  createTestUser,
} from "./helpers.js";

vi.mock("../src/repositories/audit-log.repository.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/repositories/audit-log.repository.js")
    >();

  return {
    ...original,
    createAuditLog: vi.fn(original.createAuditLog),
  };
});

describe("session revocation + audit are atomic", () => {
  it("rolls back a single-session revoke when the audit write fails", async () => {
    const user = await createTestUser();
    const current = await createTestSession(user);
    const other = await createTestSession(user);

    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    const res = await request(app)
      .delete(`/api/auth/sessions/${other.sessionId}`)
      .set("Authorization", bearer(current.accessToken));

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(res.body)).not.toContain(
      "audit write failed",
    );

    const stored = await Session.findById(other.sessionId).exec();
    expect(stored?.revokedAt ?? null).toBeNull();
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("rolls back revoke-all when the audit write fails", async () => {
    const user = await createTestUser();
    const s1 = await createTestSession(user);
    const s2 = await createTestSession(user);

    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    const res = await request(app)
      .delete("/api/auth/sessions")
      .set("Authorization", bearer(s1.accessToken));

    expect(res.status).toBe(500);

    for (const session of [s1, s2]) {
      const stored = await Session.findById(
        session.sessionId,
      ).exec();
      expect(stored?.revokedAt ?? null).toBeNull();
    }

    expect(await AuditLog.countDocuments()).toBe(0);
  });
});
