import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import * as auditRepository from "../src/repositories/audit-log.repository.js";
import { savePasswordResetToken } from "../src/repositories/password-reset-token.repository.js";
import { hashToken } from "../src/utils/token.util.js";

import { createTestSession, createTestUser } from "./helpers.js";

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

describe("password reset + session revocation + audit are atomic", () => {
  it("rolls back the password change and the session revokes when the audit write fails", async () => {
    const user = await createTestUser();
    const s1 = await createTestSession(user);
    const s2 = await createTestSession(user);

    const rawToken = "c".repeat(64);

    await savePasswordResetToken(
      hashToken(rawToken),
      {
        userId: user.userId,
        organizationId: user.organizationId,
      },
      600,
    );

    const before = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "Brand-New-Passw0rd!" });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(
      "audit write failed",
    );

    const after = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.passwordChangedAt ?? null).toBeNull();

    for (const session of [s1, s2]) {
      const stored = await Session.findById(session.sessionId).exec();
      expect(stored?.revokedAt ?? null).toBeNull();
    }

    expect(await AuditLog.countDocuments()).toBe(0);
  });
});
