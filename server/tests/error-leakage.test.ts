import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Organization } from "../src/models/organization.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import {
  errorHandler,
  notFoundHandler,
} from "../src/middleware/error.middleware.js";
import * as emailService from "../src/services/email.service.js";

import {
  createTestSession,
  createTestUser,
  getSetCookies,
  TEST_PASSWORD,
} from "./helpers.js";

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

const sendVerificationMock = vi.mocked(
  emailService.sendVerificationEmail,
);

const ERROR_BODY_KEYS = ["code", "fields", "message"];

const expectStandardError = (
  body: {
    success: boolean;
    error: { code: string; message: string; fields: unknown };
  },
  code: string,
): void => {
  expect(body.success).toBe(false);
  expect(Object.keys(body).sort()).toEqual(["error", "success"]);
  expect(Object.keys(body.error).sort()).toEqual(ERROR_BODY_KEYS);
  expect(body.error.code).toBe(code);
};

/*
 * Things that must never appear in a client response.
 */
const expectNoInternals = (value: unknown): void => {
  const raw = JSON.stringify(value);

  for (const forbidden of [
    "stack",
    "node_modules",
    "src/",
    "src\\\\",
    "tests/",
    "mongodb://",
    "mongodb",
    "redis://",
    "E11000",
    "email_1",
    "MongoServerError",
    "JsonWebTokenError",
    "TokenExpiredError",
    "argon2",
    "low_code_platform",
    "JWT_",
    "passwordHash",
  ]) {
    expect(raw).not.toContain(forbidden);
  }
};

const extractRefreshCookie = (headers: {
  [key: string]: unknown;
}): string => {
  for (const cookie of getSetCookies(headers)) {
    const match = /^refreshToken=([^;]+);/.exec(cookie);

    if (match?.[1]) {
      return match[1];
    }
  }

  throw new Error("No refresh cookie was set");
};

const refreshWith = (token: string) =>
  request(app)
    .post("/api/auth/refresh")
    .set("Cookie", `refreshToken=${token}`);

beforeEach(() => {
  sendVerificationMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("centralized error handler", () => {
  const buildTestApp = () => {
    const testApp = express();
    testApp.use(express.json());

    testApp.get("/boom", () => {
      throw new Error("boom");
    });

    testApp.post("/boom-sensitive", () => {
      const error = Object.assign(new Error("boom"), {
        password: "hunter2",
        body: { password: "hunter2" },
        config: { auth: { password: "redis-pass" } },
        response: { headers: { authorization: "Bearer abc.def.ghi" } },
        connectionString: "mongodb://user:db-pass@internal-host/db",
      });

      throw error;
    });

    testApp.get("/boom-async", async () => {
      await Promise.resolve();
      throw new Error("async failure /secret/internal/path.ts");
    });

    testApp.get("/boom-string", () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "plain string failure with db-pass";
    });

    testApp.get("/boom-duplicate", () => {
      throw Object.assign(
        new Error(
          'E11000 duplicate key error collection: low_code_platform.users index: email_1 dup key: { email: "victim@example.com" }',
        ),
        { code: 11000, keyValue: { email: "victim@example.com" } },
      );
    });

    testApp.use(notFoundHandler);
    testApp.use(errorHandler);

    return testApp;
  };

  it("returns a generic 500 and never the error message, stack or paths", async () => {
    const testApp = buildTestApp();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const path of [
      "/boom",
      "/boom-async",
      "/boom-string",
      "/boom-duplicate",
    ]) {
      const res = await request(testApp).get(path);

      expect(res.status).toBe(500);
      expectStandardError(res.body, "INTERNAL_SERVER_ERROR");
      expect(res.body.error.message).toBe(
        "An unexpected error occurred",
      );
      expect(res.body.error.fields).toEqual({});
      expectNoInternals(res.body);
      expect(JSON.stringify(res.body)).not.toContain("victim");
      expect(JSON.stringify(res.body)).not.toContain("secret");
    }
  });

  it("handles rejected async handlers without crashing", async () => {
    const testApp = buildTestApp();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(testApp).get("/boom-async");

    expect(res.status).toBe(500);

    // The server is still serving requests afterwards.
    const next = await request(testApp).get("/boom");
    expect(next.status).toBe(500);
  });

  it("returns the same body for every unexpected error", async () => {
    const testApp = buildTestApp();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const a = await request(testApp).get("/boom");
    const b = await request(testApp).get("/boom-duplicate");

    expect(a.body).toEqual(b.body);
  });

  it("logs the error class, stack, method and path for developers", async () => {
    const testApp = buildTestApp();
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await request(testApp).get("/boom");

    const logged = JSON.stringify(spy.mock.calls);

    expect(logged).toContain("Unhandled error");
    expect(logged).toContain("GET");
    expect(logged).toContain("/boom");
    expect(logged).toContain('"name":"Error"');
    expect(logged).toContain("boom");
    expect(logged).toContain("stack");
  });

  it("does not dump sensitive error properties, request data or query strings into the logs", async () => {
    const testApp = buildTestApp();
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await request(testApp)
      .post("/boom-sensitive")
      .query({ token: "SECRET-QUERY-TOKEN" })
      .set("Authorization", "Bearer header.payload.signature")
      .send({ password: "hunter2" });

    const logged = JSON.stringify(spy.mock.calls);

    expect(logged).toContain("/boom-sensitive");

    for (const secret of [
      "hunter2",
      "redis-pass",
      "db-pass",
      "SECRET-QUERY-TOKEN",
      "abc.def.ghi",
      "header.payload.signature",
      "internal-host",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("redacts duplicate-key values (emails) in logs", async () => {
    const testApp = buildTestApp();
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await request(testApp).get("/boom-duplicate");

    const logged = JSON.stringify(spy.mock.calls);

    expect(logged).toContain("E11000");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain("victim@example.com");
  });

  it("does not log client errors as unexpected errors", async () => {
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await request(app).get("/api/auth/sessions/%E0%A4%A");
    await request(app).get("/api/does-not-exist");

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("client errors are 4xx, not 500", () => {
  it("returns a JSON 404 for unknown routes without echoing the path", async () => {
    for (const res of [
      await request(app).get("/api/nope-secret-path"),
      await request(app).post("/api/auth/nope-secret-path").send({}),
      await request(app).delete("/api/nope-secret-path"),
    ]) {
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expectStandardError(res.body, "NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toContain("secret-path");
      expect(res.text).not.toContain("<html");
      expect(res.text).not.toContain("Cannot");
    }
  });

  it("returns 400 for a malformed URL", async () => {
    const res = await request(app).get("/api/auth/sessions/%E0%A4%A");

    expect(res.status).toBe(400);
    expectStandardError(res.body, "BAD_REQUEST");
    expect(res.body.error.message).toBe("Bad request");
    expectNoInternals(res.body);
    expect(JSON.stringify(res.body)).not.toContain("decode");
  });

  it("returns 415 for an unsupported Content-Encoding", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "x-unsupported")
      .send("xx");

    expect(res.status).toBe(415);
    expectStandardError(res.body, "UNSUPPORTED_MEDIA_TYPE");
    expect(res.body.error.message).toBe("Unsupported media type");
    expect(JSON.stringify(res.body)).not.toContain("x-unsupported");
  });

  it("returns 400 for a corrupt compressed body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "br")
      .send("xx");

    expect(res.status).toBe(400);
    expectStandardError(res.body, "BAD_REQUEST");
    expect(JSON.stringify(res.body)).not.toContain("end of file");
  });

  it("keeps the dedicated malformed-JSON and oversized-body responses", async () => {
    const badJson = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{bad");

    expect(badJson.status).toBe(400);
    expectStandardError(badJson.body, "INVALID_JSON");
    expect(JSON.stringify(badJson.body)).not.toContain("bad");

    const tooLarge = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "x".repeat(2 * 1024 * 1024) }));

    expect(tooLarge.status).toBe(413);
    expectStandardError(tooLarge.body, "PAYLOAD_TOO_LARGE");
  });

  it("does not echo submitted values in validation errors", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email-SENTINEL", password: "pw-SENTINEL" });

    expect(res.status).toBe(400);
    expectStandardError(res.body, "VALIDATION_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("SENTINEL");
  });

  it("sets no X-Powered-By or Server header", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["server"]).toBeUndefined();
  });
});

describe("database error details are not exposed", () => {
  it("does not leak duplicate-key (index, collection, database) details when registering an existing email", async () => {
    const body = {
      firstName: "Dup",
      lastName: "User",
      email: "dup-leak@example.com",
      password: "Duplicate-Passw0rd!",
      organizationName: "Dup Org",
    };

    expect(
      (await request(app).post("/api/auth/register").send(body)).status,
    ).toBe(201);

    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await request(app).post("/api/auth/register").send(body);

    // Accepted existing behavior: a generic 500 (see report).
    expect(res.status).toBe(500);
    expectStandardError(res.body, "INTERNAL_SERVER_ERROR");
    expectNoInternals(res.body);
    expect(JSON.stringify(res.body)).not.toContain("dup-leak");

    // The failed attempt left nothing behind and the log has no email.
    expect(await User.countDocuments()).toBe(1);
    expect(await Organization.countDocuments()).toBe(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(
      "dup-leak@example.com",
    );
  });
});

describe("login errors", () => {
  const login = (email: string, password: string) =>
    request(app).post("/api/auth/login").send({ email, password });

  it("returns 401 INVALID_CREDENTIALS, identical for unknown email and wrong password", async () => {
    const user = await createTestUser();

    const unknown = await login("nobody@example.com", "whatever-pass-1");
    const wrong = await login(user.email, "wrong-password-1");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expectStandardError(unknown.body, "INVALID_CREDENTIALS");
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body.error.message).toBe("Invalid email or password");
    expectNoInternals(wrong.body);
    expect(JSON.stringify(wrong.body)).not.toContain(user.email);
  });

  it("does not log a failed login as an unexpected error", async () => {
    const user = await createTestUser();
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await login(user.email, "wrong-password-1");

    expect(spy).not.toHaveBeenCalled();
  });

  it("reports an inactive account only after the correct password (403)", async () => {
    const suspended = await createTestUser();
    await User.updateOne(
      { _id: suspended.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const wrongPassword = await login(suspended.email, "wrong-password-1");
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");

    const correct = await login(suspended.email, TEST_PASSWORD);
    expect(correct.status).toBe(403);
    expectStandardError(correct.body, "ACCOUNT_NOT_ACTIVE");

    const orgUser = await createTestUser();
    await Organization.updateOne(
      { _id: orgUser.organizationId },
      { $set: { status: "SUSPENDED" } },
    );

    const orgResult = await login(orgUser.email, TEST_PASSWORD);
    expect(orgResult.status).toBe(403);
    expect(orgResult.body).toEqual(correct.body);
  });

  it("never returns passwords, hashes or tokens in a failed login", async () => {
    const user = await createTestUser();

    const res = await login(user.email, "wrong-password-SENTINEL");
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain("SENTINEL");
    expect(raw).not.toContain("accessToken");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("refresh-token errors", () => {
  it("returns the same generic 401 for unknown, expired and reused tokens", async () => {
    const user = await createTestUser();

    const unknown = await refreshWith("a".repeat(64));

    const expiredSession = await createTestSession(user);
    await Session.updateOne(
      { _id: expiredSession.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const expired = await refreshWith(expiredSession.refreshToken);

    const reusable = await createTestSession(user);
    const first = await refreshWith(reusable.refreshToken);
    expect(first.status).toBe(200);
    const reused = await refreshWith(reusable.refreshToken);

    for (const res of [unknown, expired, reused]) {
      expect(res.status).toBe(401);
      expectStandardError(res.body, "INVALID_REFRESH_TOKEN");
      expectNoInternals(res.body);
    }

    expect(expired.body).toEqual(unknown.body);
    expect(reused.body).toEqual(unknown.body);
  });

  it("still revokes the whole token family on reuse (detection preserved)", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const rotated = await refreshWith(original.refreshToken);
    expect(rotated.status).toBe(200);
    const newRefreshToken = extractRefreshCookie(rotated.headers);

    const stillActiveBefore = await Session.countDocuments({
      userId: user.userId,
      revokedAt: null,
    });
    expect(stillActiveBefore).toBe(1);

    const reuse = await refreshWith(original.refreshToken);
    expect(reuse.status).toBe(401);

    expect(
      await Session.countDocuments({
        userId: user.userId,
        revokedAt: null,
      }),
    ).toBe(0);

    const afterReuse = await refreshWith(newRefreshToken);
    expect(afterReuse.status).toBe(401);
    expect(afterReuse.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("does not log a refused refresh token as an unexpected error", async () => {
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await refreshWith("a".repeat(64));

    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 403 ACCOUNT_NOT_ACTIVE for a suspended user or organization without rotating", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const res = await refreshWith(session.refreshToken);

    expect(res.status).toBe(403);
    expectStandardError(res.body, "ACCOUNT_NOT_ACTIVE");
    expect(
      (await Session.findById(session.sessionId).exec())?.revokedAt ??
        null,
    ).toBeNull();

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "ACTIVE" } },
    );
    await Organization.updateOne(
      { _id: user.organizationId },
      { $set: { status: "DELETED" } },
    );

    const orgRes = await refreshWith(session.refreshToken);
    expect(orgRes.status).toBe(403);
    expect(orgRes.body).toEqual(res.body);
  });

  it("returns 401 for a missing refresh cookie", async () => {
    const res = await request(app).post("/api/auth/refresh");

    expect(res.status).toBe(401);
    expectStandardError(res.body, "UNAUTHORIZED");
  });
});

describe("verification errors and enumeration", () => {
  it("returns the same 400 for unknown and already-used verification tokens", async () => {
    const unknown = await request(app)
      .get("/api/auth/verify-email")
      .query({ token: "a".repeat(64) });

    expect(unknown.status).toBe(400);
    expectStandardError(unknown.body, "INVALID_OR_EXPIRED_TOKEN");

    const registered = await request(app)
      .post("/api/auth/register")
      .send({
        firstName: "Ver",
        lastName: "Ify",
        email: "verify-me@example.com",
        password: "Verification-Passw0rd!",
        organizationName: "Verify Org",
      });
    expect(registered.status).toBe(201);

    const url = sendVerificationMock.mock.calls.at(-1)?.[1] ?? "";
    const token = new URL(url).searchParams.get("token") ?? "";

    expect(
      (
        await request(app)
          .get("/api/auth/verify-email")
          .query({ token })
      ).status,
    ).toBe(200);

    const reused = await request(app)
      .get("/api/auth/verify-email")
      .query({ token });

    expect(reused.status).toBe(400);
    expect(reused.body).toEqual(unknown.body);
  });

  it("resend-verification reveals neither account nor organization existence", async () => {
    const user = await createTestUser();
    await User.updateOne(
      { _id: user.userId },
      { $set: { emailVerified: false } },
    );

    const existing = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: user.email, organizationId: user.organizationId });

    const unknownEmail = await request(app)
      .post("/api/auth/resend-verification")
      .send({
        email: "nobody@example.com",
        organizationId: user.organizationId,
      });

    const unknownOrg = await request(app)
      .post("/api/auth/resend-verification")
      .send({
        email: user.email,
        organizationId: "0".repeat(24),
      });

    for (const res of [existing, unknownEmail, unknownOrg]) {
      expect(res.status).toBe(200);
    }

    expect(unknownEmail.body).toEqual(existing.body);
    expect(unknownOrg.body).toEqual(existing.body);
  });

  it("writes no audit record for failed logins or refused tokens", async () => {
    await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever-pass-1" });
    await refreshWith("a".repeat(64));

    expect(await AuditLog.countDocuments()).toBe(0);
  });
});
