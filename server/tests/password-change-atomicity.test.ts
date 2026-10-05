import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import * as auditRepository from "../src/repositories/audit-log.repository.js";
import * as sessionRepository from "../src/repositories/session.repository.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  TEST_PASSWORD,
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

vi.mock("../src/repositories/session.repository.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/repositories/session.repository.js")
    >();

  return {
    ...original,
    revokeAllActiveSessionsForUser: vi.fn(
      original.revokeAllActiveSessionsForUser,
    ),
  };
});

const NEW_PASSWORD = "Brand-New-Passw0rd!";

const arrange = async () => {
  const user = await createTestUser();
  const s1 = await createTestSession(user);
  const s2 = await createTestSession(user);

  const hashBefore = (
    await User.findById(user.userId).select("+passwordHash").exec()
  )?.passwordHash;

  return { user, s1, s2, hashBefore };
};

const expectNothingChanged = async (
  arranged: Awaited<ReturnType<typeof arrange>>,
) => {
  const after = await User.findById(arranged.user.userId)
    .select("+passwordHash")
    .exec();

  expect(after?.passwordHash).toBe(arranged.hashBefore);
  expect(after?.passwordChangedAt ?? null).toBeNull();

  for (const session of [arranged.s1, arranged.s2]) {
    const stored = await Session.findById(session.sessionId).exec();
    expect(stored?.revokedAt ?? null).toBeNull();
  }

  expect(await AuditLog.countDocuments()).toBe(0);
};

describe("change-password is atomic", () => {
  it("rolls back the password change and the session revokes when the audit write fails", async () => {
    const arranged = await arrange();

    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(arranged.s1.accessToken))
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(res.body)).not.toContain(
      "audit write failed",
    );

    await expectNothingChanged(arranged);
  });

  it("rolls back the password change and the audit record when session revocation fails", async () => {
    const arranged = await arrange();

    vi.mocked(
      sessionRepository.revokeAllActiveSessionsForUser,
    ).mockRejectedValueOnce(new Error("revocation failed"));

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(arranged.s1.accessToken))
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(
      "revocation failed",
    );

    await expectNothingChanged(arranged);
  });

  it("still succeeds normally after a rolled-back attempt", async () => {
    const arranged = await arrange();

    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(arranged.s1.accessToken))
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    const retry = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(arranged.s1.accessToken))
      .send({
        currentPassword: TEST_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

    expect(retry.status).toBe(200);
    expect(
      await AuditLog.countDocuments({ action: "PASSWORD_CHANGED" }),
    ).toBe(1);
  });
});
