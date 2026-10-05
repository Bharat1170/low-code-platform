import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Organization } from "../src/models/organization.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import * as auditRepository from "../src/repositories/audit-log.repository.js";
import * as emailService from "../src/services/email.service.js";
import { hashToken } from "../src/utils/token.util.js";

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

const PASSWORD = "Registration-Passw0rd!";

const sendVerificationMock = vi.mocked(
  emailService.sendVerificationEmail,
);

const payload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  firstName: "Ada",
  lastName: "Lovelace",
  email: `ada-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  password: PASSWORD,
  organizationName: "Analytical Engines",
  ...overrides,
});

const register = (
  body: Record<string, unknown>,
  userAgent = "vitest-registration-agent",
) =>
  request(app)
    .post("/api/auth/register")
    .set("User-Agent", userAgent)
    .send(body);

const emailedToken = (): string => {
  const call = sendVerificationMock.mock.calls.at(-1);

  if (!call) {
    throw new Error("No verification email was sent");
  }

  const token = new URL(call[1]).searchParams.get("token");

  if (!token) {
    throw new Error("Verification URL has no token");
  }

  return token;
};

beforeEach(() => {
  sendVerificationMock.mockReset();
});

describe("registration audit (USER_REGISTERED)", () => {
  it("registers successfully and writes exactly one USER_REGISTERED audit record", async () => {
    const res = await register(payload());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const audits = await AuditLog.find({
      action: "USER_REGISTERED",
    }).exec();

    expect(audits).toHaveLength(1);
    expect(await AuditLog.countDocuments()).toBe(1);
  });

  it("records the trusted organizationId, userId and resource", async () => {
    const body = payload();
    const res = await register(body);

    const { userId, organizationId } = res.body.data;

    const user = await User.findById(userId).exec();
    const organization = await Organization.findById(
      organizationId,
    ).exec();

    expect(user?.organizationId.toString()).toBe(organizationId);
    expect(organization).not.toBeNull();

    const audit = await AuditLog.findOne({
      action: "USER_REGISTERED",
    }).exec();

    expect(audit?.organizationId.toString()).toBe(organizationId);
    expect(audit?.userId.toString()).toBe(userId);
    expect(audit?.action).toBe("USER_REGISTERED");
    expect(audit?.resourceType).toBe("USER");
    expect(audit?.resourceId?.toString()).toBe(userId);
    expect(audit?.metadata).toEqual({});
    expect(audit?.createdAt).toBeInstanceOf(Date);
  });

  it("stores the request IP and user agent", async () => {
    await register(payload(), "vitest-registration-agent");

    const audit = await AuditLog.findOne({
      action: "USER_REGISTERED",
    }).exec();

    expect(audit?.userAgent).toBe("vitest-registration-agent");
    // supertest connects over loopback.
    expect(audit?.ipAddress).toMatch(
      /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/,
    );
  });

  it("does not trust a client-supplied X-Forwarded-For for the IP", async () => {
    await request(app)
      .post("/api/auth/register")
      .set("User-Agent", "vitest-registration-agent")
      .set("X-Forwarded-For", "203.0.113.77")
      .send(payload());

    const audit = await AuditLog.findOne({
      action: "USER_REGISTERED",
    }).exec();

    expect(audit?.ipAddress).not.toContain("203.0.113.77");
  });

  it("rejects client-supplied audit context fields in the body", async () => {
    const res = await register(
      payload({
        ipAddress: "203.0.113.5",
        userAgent: "forged-agent",
        organizationId: "0".repeat(24),
        userId: "0".repeat(24),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await AuditLog.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(0);
  });

  it("truncates an oversized user agent instead of failing registration", async () => {
    const res = await register(payload(), "a".repeat(1500));

    expect(res.status).toBe(201);

    const audit = await AuditLog.findOne({
      action: "USER_REGISTERED",
    }).exec();

    expect(audit?.userAgent).toHaveLength(1000);
  });

  it("stores no password, hash, token or secret in the audit data", async () => {
    const body = payload();
    const res = await register(body);

    expect(res.status).toBe(201);

    const token = emailedToken();

    const user = await User.findById(res.body.data.userId)
      .select("+passwordHash")
      .exec();

    const raw = JSON.stringify(
      await AuditLog.find().lean().exec(),
    );

    for (const secret of [
      PASSWORD,
      user?.passwordHash ?? "missing",
      "passwordHash",
      token,
      hashToken(token),
      process.env.JWT_ACCESS_SECRET ?? "missing",
      process.env.JWT_REFRESH_SECRET ?? "missing",
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("creates the owner role, user and organization before the audit record", async () => {
    const res = await register(payload());

    const role = await Role.findOne({
      organizationId: res.body.data.organizationId,
      name: "OWNER",
    }).exec();

    expect(role).not.toBeNull();

    const user = await User.findById(res.body.data.userId).exec();
    expect(user?.roleIds.map(String)).toEqual([role?._id.toString()]);

    const audit = await AuditLog.findOne({
      action: "USER_REGISTERED",
    }).exec();

    expect(audit).not.toBeNull();
  });

  it("preserves the verification email flow", async () => {
    const body = payload();
    const res = await register(body);

    expect(res.status).toBe(201);
    expect(sendVerificationMock).toHaveBeenCalledTimes(1);
    expect(sendVerificationMock.mock.calls[0]?.[0]).toBe(body.email);

    const token = emailedToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await redisClient.exists(
        `auth:email-verification:${hashToken(token)}`,
      ),
    ).toBe(1);

    const verify = await request(app)
      .get("/api/auth/verify-email")
      .query({ token });

    expect(verify.status).toBe(200);

    const user = await User.findById(res.body.data.userId).exec();
    expect(user?.emailVerified).toBe(true);
  });

  it("rolls back organization, role and user when the audit write fails", async () => {
    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    const res = await register(payload());

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(res.body)).not.toContain(
      "audit write failed",
    );

    expect(await Organization.countDocuments()).toBe(0);
    expect(await Role.countDocuments()).toBe(0);
    expect(await User.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments()).toBe(0);

    // No verification token stored, no email sent.
    expect(
      await redisClient.keys("auth:email-verification:*"),
    ).toHaveLength(0);
    expect(sendVerificationMock).not.toHaveBeenCalled();
  });

  it("can register again with the same email after a rolled-back attempt", async () => {
    const body = payload();

    vi.mocked(auditRepository.createAuditLog).mockRejectedValueOnce(
      new Error("audit write failed"),
    );

    const failed = await register(body);
    expect(failed.status).toBe(500);

    const retry = await register(body);
    expect(retry.status).toBe(201);

    expect(
      await AuditLog.countDocuments({ action: "USER_REGISTERED" }),
    ).toBe(1);
  });

  it("does not write an audit record for a rejected registration", async () => {
    const first = payload();

    expect((await register(first)).status).toBe(201);

    const duplicate = await register(first);

    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(
      await AuditLog.countDocuments({ action: "USER_REGISTERED" }),
    ).toBe(1);
    expect(await User.countDocuments()).toBe(1);
    expect(await Organization.countDocuments()).toBe(1);
  });

  it("keeps each registration's audit record in its own organization", async () => {
    const a = await register(payload());
    const b = await register(payload({ organizationName: "Other Co" }));

    const auditA = await AuditLog.findOne({
      userId: a.body.data.userId,
    }).exec();
    const auditB = await AuditLog.findOne({
      userId: b.body.data.userId,
    }).exec();

    expect(auditA?.organizationId.toString()).toBe(
      a.body.data.organizationId,
    );
    expect(auditB?.organizationId.toString()).toBe(
      b.body.data.organizationId,
    );
    expect(auditA?.organizationId.toString()).not.toBe(
      auditB?.organizationId.toString(),
    );
  });
});
