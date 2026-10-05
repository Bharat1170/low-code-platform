import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import * as emailService from "../src/services/email.service.js";
import { hashToken } from "../src/utils/token.util.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  getSetCookies,
  TEST_PASSWORD,
} from "./helpers.js";
import { serverSecrets } from "./security-helpers.js";

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
 * 8.15.11 / 9 - Audit logging.
 *
 * Registration, session revocation, password reset and password change
 * audits are asserted in their own suites. This file adds login and
 * logout, and a full-lifecycle scan proving that no secret ever reaches
 * an audit record, a log line or a response body.
 */

const sendVerificationMock = vi.mocked(
  emailService.sendVerificationEmail,
);
const sendResetMock = vi.mocked(emailService.sendPasswordResetEmail);

const refreshCookieValue = (headers: {
  [key: string]: unknown;
}): string => {
  for (const raw of getSetCookies(headers)) {
    const match = /^refreshToken=([^;]+);/.exec(raw);

    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error("No refresh cookie was set");
};

const tokenFromUrl = (url: string | undefined): string => {
  const token = new URL(url ?? "http://x/").searchParams.get("token");

  if (!token) {
    throw new Error("No token in URL");
  }

  return token;
};

beforeEach(() => {
  sendVerificationMock.mockReset();
  sendResetMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("login audit", () => {
  it("records USER_LOGIN with the trusted identity, session id and request context", async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .set("User-Agent", "vitest-login-agent")
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);

    const session = await Session.findOne({ userId: user.userId }).exec();
    const audits = await AuditLog.find({ action: "USER_LOGIN" }).exec();

    expect(audits).toHaveLength(1);

    const audit = audits[0];

    expect(audit?.organizationId.toString()).toBe(user.organizationId);
    expect(audit?.userId.toString()).toBe(user.userId);
    expect(audit?.resourceType).toBe("USER");
    expect(audit?.resourceId?.toString()).toBe(user.userId);
    expect(audit?.userAgent).toBe("vitest-login-agent");
    expect(audit?.ipAddress).toMatch(
      /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/,
    );
    expect(audit?.createdAt).toBeInstanceOf(Date);
    expect(Object.keys(audit?.metadata ?? {}).sort()).toEqual([
      "previousLoginIpAddress",
      "sessionId",
      "suspiciousLogin",
    ]);
    expect(audit?.metadata).toMatchObject({
      sessionId: session?._id.toString(),
      suspiciousLogin: false,
      previousLoginIpAddress: null,
    });
  });

  it("does not trust a client-supplied IP header for the audit record", async () => {
    const user = await createTestUser();

    await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.50")
      .set("X-Real-IP", "203.0.113.51")
      .send({ email: user.email, password: TEST_PASSWORD });

    const audit = await AuditLog.findOne({ action: "USER_LOGIN" }).exec();

    expect(audit?.ipAddress).not.toContain("203.0.113");
  });

  it("writes no audit record for failed, blocked or invalid logins", async () => {
    const user = await createTestUser();

    await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "wrong-password-1" });
    await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever-pass-1" });
    await request(app)
      .post("/api/auth/login")
      .send({ email: { $ne: "" }, password: "x" });

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "SUSPENDED" } },
    );
    await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(await AuditLog.countDocuments()).toBe(0);
    expect(await Session.countDocuments()).toBe(0);
  });

  it("stores no password, hash or token in the login audit", async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    const stored = await User.findById(user.userId)
      .select("+passwordHash")
      .exec();

    const raw = JSON.stringify(await AuditLog.find().lean().exec());
    const refreshToken = refreshCookieValue(res.headers);

    for (const secret of [
      TEST_PASSWORD,
      stored?.passwordHash ?? "missing",
      res.body.data.accessToken as string,
      refreshToken,
      hashToken(refreshToken),
    ]) {
      expect(raw).not.toContain(secret);
    }
  });
});

describe("logout audit", () => {
  it("records USER_LOGOUT for the revoked session", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("User-Agent", "vitest-logout-agent")
      .set("Cookie", `refreshToken=${session.refreshToken}`);

    expect(res.status).toBe(200);

    const audits = await AuditLog.find({ action: "USER_LOGOUT" }).exec();

    expect(audits).toHaveLength(1);
    expect(audits[0]?.organizationId.toString()).toBe(user.organizationId);
    expect(audits[0]?.userId.toString()).toBe(user.userId);
    expect(audits[0]?.resourceType).toBe("SESSION");
    expect(audits[0]?.resourceId?.toString()).toBe(session.sessionId);
    expect(audits[0]?.metadata).toEqual({});
    expect(audits[0]?.userAgent).toBe("vitest-logout-agent");

    const raw = JSON.stringify(audits);
    expect(raw).not.toContain(session.refreshToken);
    expect(raw).not.toContain(hashToken(session.refreshToken));
    expect(raw).not.toContain(session.accessToken);
  });

  it("is idempotent and writes no audit for an unknown, repeated or missing token", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const first = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${session.refreshToken}`);
    const repeated = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${session.refreshToken}`);
    const unknown = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${"f".repeat(64)}`);
    const missing = await request(app).post("/api/auth/logout");

    for (const res of [first, repeated, unknown, missing]) {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }

    expect(
      await AuditLog.countDocuments({ action: "USER_LOGOUT" }),
    ).toBe(1);
  });
});

describe("full lifecycle: no secret reaches an audit record, a log or a response body", () => {
  it("scans every audit record, log line and response across the whole account lifecycle", async () => {
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
    ];

    const bodies: string[] = [];
    const track = (res: request.Response): request.Response => {
      bodies.push(res.text);
      return res;
    };

    const email = `lifecycle-${Date.now()}@example.com`;
    const passwords = {
      initial: "Lifecycle-Initial-Passw0rd!",
      reset: "Lifecycle-Reset-Passw0rd!",
      changed: "Lifecycle-Changed-Passw0rd!",
    };

    const accessTokens: string[] = [];
    const refreshTokens: string[] = [];

    // 1. Register + verify.
    const registered = track(
      await request(app)
        .post("/api/auth/register")
        .set("User-Agent", "lifecycle-agent")
        .send({
          firstName: "Life",
          lastName: "Cycle",
          email,
          password: passwords.initial,
          organizationName: "Lifecycle Org",
        }),
    );
    expect(registered.status).toBe(201);

    const userId = registered.body.data.userId as string;
    const organizationId = registered.body.data.organizationId as string;

    const verificationToken = tokenFromUrl(
      sendVerificationMock.mock.calls.at(-1)?.[1],
    );

    expect(
      track(
        await request(app)
          .get("/api/auth/verify-email")
          .query({ token: verificationToken }),
      ).status,
    ).toBe(200);

    const passwordHashes: string[] = [];
    const snapshotHash = async (): Promise<void> => {
      const user = await User.findById(userId).select("+passwordHash").exec();
      passwordHashes.push(user?.passwordHash ?? "missing");
    };
    await snapshotHash();

    const loginAs = async (password: string) => {
      const res = track(
        await request(app)
          .post("/api/auth/login")
          .set("User-Agent", "lifecycle-agent")
          .send({ email, password }),
      );

      expect(res.status).toBe(200);
      accessTokens.push(res.body.data.accessToken as string);
      refreshTokens.push(refreshCookieValue(res.headers));

      return res;
    };

    // 2. Login, list sessions, refresh.
    const login1 = await loginAs(passwords.initial);

    expect(
      track(
        await request(app)
          .get("/api/auth/sessions")
          .set("Authorization", bearer(login1.body.data.accessToken)),
      ).status,
    ).toBe(200);

    const refreshed = track(
      await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${refreshTokens[0]}`),
    );
    expect(refreshed.status).toBe(200);
    accessTokens.push(refreshed.body.data.accessToken as string);
    refreshTokens.push(refreshCookieValue(refreshed.headers));

    // 3. Forgot + reset password.
    expect(
      track(
        await request(app)
          .post("/api/auth/forgot-password")
          .set("User-Agent", "lifecycle-agent")
          .send({ email }),
      ).status,
    ).toBe(200);

    const resetToken = tokenFromUrl(sendResetMock.mock.calls.at(-1)?.[1]);

    expect(
      track(
        await request(app)
          .post("/api/auth/reset-password")
          .set("User-Agent", "lifecycle-agent")
          .send({ token: resetToken, newPassword: passwords.reset }),
      ).status,
    ).toBe(200);
    await snapshotHash();

    // 4. Login with the reset password, change it, login again.
    const login2 = await loginAs(passwords.reset);

    expect(
      track(
        await request(app)
          .post("/api/auth/change-password")
          .set("Authorization", bearer(login2.body.data.accessToken))
          .set("User-Agent", "lifecycle-agent")
          .send({
            currentPassword: passwords.reset,
            newPassword: passwords.changed,
          }),
      ).status,
    ).toBe(200);
    await snapshotHash();

    const login3 = await loginAs(passwords.changed);

    // 5. Logout, then login again and revoke everything.
    track(
      await request(app)
        .post("/api/auth/logout")
        .set("User-Agent", "lifecycle-agent")
        .set("Cookie", `refreshToken=${refreshTokens.at(-1)}`),
    );

    const login4 = await loginAs(passwords.changed);

    expect(
      track(
        await request(app)
          .delete("/api/auth/sessions")
          .set("Authorization", bearer(login4.body.data.accessToken))
          .set("User-Agent", "lifecycle-agent"),
      ).status,
    ).toBe(200);

    void login3;

    // ---- Expected audit trail -------------------------------------------
    const audits = await AuditLog.find().sort({ createdAt: 1 }).lean().exec();

    const count = (action: string): number =>
      audits.filter((audit) => audit.action === action).length;

    expect(count("USER_REGISTERED")).toBe(1);
    expect(count("USER_LOGIN")).toBe(4);
    expect(count("PASSWORD_RESET_REQUESTED")).toBe(1);
    expect(count("PASSWORD_RESET_COMPLETED")).toBe(1);
    expect(count("PASSWORD_CHANGED")).toBe(1);
    expect(count("USER_LOGOUT")).toBe(1);
    expect(count("SESSIONS_REVOKED_ALL")).toBe(1);

    // Every audit record is complete, tenant-correct and attributable.
    const allowedMetadata: Record<string, string[]> = {
      USER_REGISTERED: [],
      USER_LOGIN: [
        "previousLoginIpAddress",
        "sessionId",
        "suspiciousLogin",
      ],
      PASSWORD_RESET_REQUESTED: [],
      PASSWORD_RESET_COMPLETED: ["revokedSessionCount"],
      PASSWORD_CHANGED: [],
      USER_LOGOUT: [],
      SESSIONS_REVOKED_ALL: ["revokedCount"],
    };

    for (const audit of audits) {
      expect(audit.organizationId.toString()).toBe(organizationId);
      expect(audit.userId.toString()).toBe(userId);
      expect(audit.action).toBeTypeOf("string");
      expect(audit.resourceType).toBeTypeOf("string");
      expect(audit.ipAddress).toBeTypeOf("string");
      expect(audit.userAgent).toBe("lifecycle-agent");
      expect(audit.createdAt).toBeInstanceOf(Date);
      expect(Object.keys(audit.metadata ?? {}).sort()).toEqual(
        allowedMetadata[audit.action],
      );
    }

    // ---- Secret scan ----------------------------------------------------
    const secretPasswords = Object.values(passwords);
    const refreshHashes = refreshTokens.map(hashToken);

    const neverAnywhere = [
      ...secretPasswords,
      ...passwordHashes,
      ...refreshTokens,
      ...refreshHashes,
      verificationToken,
      hashToken(verificationToken),
      resetToken,
      hashToken(resetToken),
      ...serverSecrets(),
    ];

    const auditDump = JSON.stringify(audits);
    const logDump = JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
    const bodyDump = bodies.join("\n");

    for (const secret of neverAnywhere) {
      expect(auditDump).not.toContain(secret);
      expect(logDump).not.toContain(secret);
      expect(bodyDump).not.toContain(secret);
    }

    // Access tokens are returned to the client by design (login/refresh),
    // but must never be stored in audit records or logs.
    for (const token of accessTokens) {
      expect(auditDump).not.toContain(token);
      expect(logDump).not.toContain(token);
    }

    expect(auditDump).not.toContain("passwordHash");
    expect(auditDump).not.toContain("refreshTokenHash");
    expect(bodyDump).not.toContain("passwordHash");
    expect(bodyDump).not.toContain("refreshTokenHash");
    expect(bodyDump).not.toContain("tokenFamilyId");
  });
});
