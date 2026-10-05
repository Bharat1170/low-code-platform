import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Organization } from "../src/models/organization.model.js";
import { Role } from "../src/models/role.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import * as emailService from "../src/services/email.service.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  getSessionFromDb,
  TEST_PASSWORD,
} from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  resetRateLimits,
  type ErrorBody,
} from "./security-helpers.js";

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
 * 8.15.11 / 8 - Input validation and injection.
 *
 * Not applicable (no such inputs exist yet): malformed dates and
 * pagination parameters. There are no list/search/date endpoints; the
 * only list endpoint, GET /api/auth/sessions, takes no parameters.
 *
 * The rate limiters run BEFORE validation, so counters are reset before
 * every request here.
 */

const SENTINEL = "SENTINEL-6f2a91";

const NOSQL_OPERATORS: Array<[string, unknown]> = [
  ["$ne", { $ne: "" }],
  ["$gt", { $gt: "" }],
  ["$regex", { $regex: ".*" }],
  ["$where", { $where: "this.passwordHash" }],
  ["$in", { $in: ["a", "b"] }],
  ["$or style", { $or: [{ a: 1 }] }],
];

const send = async (
  method: "post" | "get" | "delete",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  await resetRateLimits();

  const req = request(app)[method](path);

  for (const [name, value] of Object.entries(headers)) {
    req.set(name, value);
  }

  if (body !== undefined) {
    req.send(body as object);
  }

  return req;
};

const postJson = (path: string, body: unknown, headers = {}) =>
  send("post", path, body, headers);

const expectValidationError = (
  res: request.Response,
  label: string,
): void => {
  expect(res.status, label).toBe(400);
  expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  // A strict-schema error names the unknown key the client itself sent
  // (for example passwordHash); that is not an internal detail.
  expectNoInternals(res.body, ["passwordHash"]);
  expect(res.text, label).not.toContain(SENTINEL);
  expect(res.headers["set-cookie"], label).toBeUndefined();
};

const sendVerificationMock = vi.mocked(
  emailService.sendVerificationEmail,
);
const sendResetMock = vi.mocked(emailService.sendPasswordResetEmail);

const validRegistration = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  firstName: "Ada",
  lastName: "Lovelace",
  email: `ada-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
  password: "Valid-Passw0rd-123",
  organizationName: "Analytical Engines",
  ...overrides,
});

const expectNothingCreated = async (): Promise<void> => {
  expect(await User.countDocuments()).toBe(0);
  expect(await Organization.countDocuments()).toBe(0);
  expect(await Role.countDocuments()).toBe(0);
  expect(await AuditLog.countDocuments()).toBe(0);
  expect(sendVerificationMock).not.toHaveBeenCalled();
};

const isPolluted = (): boolean => {
  const proto = Object.prototype as Record<string, unknown>;

  return (
    "isAdmin" in proto ||
    "polluted" in proto ||
    "admin" in proto ||
    "role" in proto
  );
};

beforeEach(() => {
  sendVerificationMock.mockReset();
  sendResetMock.mockReset();
});

describe("login input validation", () => {
  it.each(NOSQL_OPERATORS)(
    "rejects a %s operator object in email and in password",
    async (_name, operator) => {
      expectValidationError(
        await postJson("/api/auth/login", {
          email: operator,
          password: TEST_PASSWORD,
        }),
        "email",
      );

      expectValidationError(
        await postJson("/api/auth/login", {
          email: "someone@example.com",
          password: operator,
        }),
        "password",
      );
    },
  );

  it("rejects arrays, numbers, booleans, null and missing values", async () => {
    for (const body of [
      { email: ["a@example.com"], password: "x" },
      { email: "a@example.com", password: ["x"] },
      { email: 123, password: "x" },
      { email: "a@example.com", password: 123 },
      { email: true, password: false },
      { email: null, password: null },
      { email: "a@example.com" },
      { password: "x" },
      {},
    ]) {
      expectValidationError(
        await postJson("/api/auth/login", body),
        JSON.stringify(body),
      );
    }
  });

  it("rejects non-object bodies", async () => {
    for (const raw of ["[]", '"text"', "123", "null", "true"]) {
      await resetRateLimits();

      const res = await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send(raw);

      expect([400]).toContain(res.status);
      expectStandardError(res.body as ErrorBody);
      expectNoInternals(res.body);
    }

    await resetRateLimits();

    const text = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "text/plain")
      .send(`{"email":"a@example.com","password":"x"}`);

    expect(text.status).toBe(400);
    expectStandardError(text.body as ErrorBody, "VALIDATION_ERROR");
  });

  it("rejects oversized values", async () => {
    expectValidationError(
      await postJson("/api/auth/login", {
        email: `${"a".repeat(310)}@example.com`,
        password: "x",
      }),
      "email 321+",
    );

    expectValidationError(
      await postJson("/api/auth/login", {
        email: "a@example.com",
        password: "p".repeat(129),
      }),
      "password 129",
    );
  });

  it("rejects unexpected fields", async () => {
    for (const extra of [
      { isAdmin: true },
      { role: "OWNER" },
      { organizationId: "0".repeat(24) },
      { $where: "1" },
      { "a.b": 1 },
    ]) {
      expectValidationError(
        await postJson("/api/auth/login", {
          email: "a@example.com",
          password: "x",
          ...extra,
        }),
        JSON.stringify(extra),
      );
    }
  });

  it("treats SQL-injection strings as plain data (no 500, no bypass)", async () => {
    const user = await createTestUser();

    for (const password of [
      "' OR '1'='1",
      "' OR 1=1 --",
      "admin'--",
      "1; DROP TABLE users;--",
      '" OR ""="',
      "'; db.users.drop(); //",
    ]) {
      const res = await postJson("/api/auth/login", {
        email: user.email,
        password,
      });

      expect(res.status).toBe(401);
      expectStandardError(res.body as ErrorBody, "INVALID_CREDENTIALS");
      expectNoInternals(res.body);
    }

    for (const email of [
      "' OR '1'='1",
      "admin'--@example.com'; DROP TABLE users;--",
      "a@example.com' OR '1'='1",
    ]) {
      const res = await postJson("/api/auth/login", {
        email,
        password: "x",
      });

      expect([400, 401]).toContain(res.status);
      expectNoInternals(res.body);
    }

    expect(await User.countDocuments()).toBe(1);
  });

  it("rejects operator syntax in form-encoded bodies (qs extended parser)", async () => {
    for (const form of [
      "email[$ne]=a&password[$ne]=b",
      "email[$gt]=&password[$gt]=",
      "email[$regex]=.*&password=x",
      "email[a][b][c][d][e][f][g][h]=1&password=x",
      "email=a%40example.com&password[]=x",
    ]) {
      await resetRateLimits();

      const res = await request(app)
        .post("/api/auth/login")
        .type("form")
        .send(form);

      expectValidationError(res, form);
    }
  });

  it("does not allow prototype pollution through the JSON body", async () => {
    for (const raw of [
      '{"__proto__":{"isAdmin":true},"email":"a@example.com","password":"x"}',
      '{"constructor":{"prototype":{"polluted":true}},"email":"a@example.com","password":"x"}',
      '{"email":"a@example.com","password":"x","__proto__":{"admin":true}}',
      '{"__proto__":{"role":"OWNER"}}',
    ]) {
      await resetRateLimits();

      const res = await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send(raw);

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(isPolluted()).toBe(false);
    }

    // The same applies to form-encoded bodies.
    await resetRateLimits();
    await request(app)
      .post("/api/auth/login")
      .type("form")
      .send("__proto__[isAdmin]=1&constructor[prototype][polluted]=1");

    expect(isPolluted()).toBe(false);
  });
});

describe("registration input validation", () => {
  const FIELDS = [
    "firstName",
    "lastName",
    "email",
    "password",
    "organizationName",
  ] as const;

  it("rejects operator objects and arrays in every field", async () => {
    for (const field of FIELDS) {
      for (const value of [
        { $ne: SENTINEL },
        { $where: SENTINEL },
        [SENTINEL],
        { nested: { deep: SENTINEL } },
      ]) {
        expectValidationError(
          await postJson(
            "/api/auth/register",
            validRegistration({ [field]: value }),
          ),
          `${field}`,
        );
      }
    }

    await expectNothingCreated();
  });

  it("rejects oversized values at the documented limits", async () => {
    const tooLong: Record<(typeof FIELDS)[number], string> = {
      firstName: "f".repeat(101),
      lastName: "l".repeat(101),
      email: `${"e".repeat(310)}@example.com`,
      password: "p".repeat(129),
      organizationName: "o".repeat(151),
    };

    for (const field of FIELDS) {
      expectValidationError(
        await postJson(
          "/api/auth/register",
          validRegistration({ [field]: tooLong[field] }),
        ),
        field,
      );
    }

    await expectNothingCreated();
  });

  it("rejects empty, whitespace-only and too-short values", async () => {
    for (const overrides of [
      { firstName: "" },
      { firstName: "   " },
      { lastName: "" },
      { lastName: "\t\n" },
      { organizationName: "a" },
      { organizationName: "     " },
      { password: "short" },
      { password: "1234567" },
      { email: "" },
      { email: "not-an-email" },
      { email: "a@b" },
    ]) {
      expectValidationError(
        await postJson(
          "/api/auth/register",
          validRegistration(overrides),
        ),
        JSON.stringify(overrides),
      );
    }

    await expectNothingCreated();
  });

  it("rejects mass-assignment and privilege fields", async () => {
    for (const extra of [
      { roleIds: ["0".repeat(24)] },
      { role: "OWNER" },
      { permissions: ["user.delete"] },
      { organizationId: "0".repeat(24) },
      { status: "ACTIVE" },
      { emailVerified: true },
      { passwordHash: "x" },
      { isAdmin: true },
    ]) {
      expectValidationError(
        await postJson(
          "/api/auth/register",
          validRegistration(extra),
        ),
        JSON.stringify(extra),
      );
    }

    await expectNothingCreated();
  });

  it("does not allow prototype pollution through registration", async () => {
    for (const raw of [
      JSON.stringify(validRegistration()).replace(
        "{",
        '{"__proto__":{"polluted":true},',
      ),
      JSON.stringify(validRegistration()).replace(
        "{",
        '{"constructor":{"prototype":{"isAdmin":true}},',
      ),
    ]) {
      await resetRateLimits();

      const res = await request(app)
        .post("/api/auth/register")
        .set("Content-Type", "application/json")
        .send(raw);

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(isPolluted()).toBe(false);
    }

    await expectNothingCreated();
  });

  it("stores SQL/NoSQL-looking text literally and never executes it", async () => {
    const firstName = "Robert'); DROP TABLE Students;--";
    const organizationName = "'; db.dropDatabase(); //";

    const res = await postJson(
      "/api/auth/register",
      validRegistration({
        firstName,
        lastName: '{"$ne":null}',
        organizationName,
      }),
    );

    expect(res.status).toBe(201);

    const user = await User.findById(res.body.data.userId).exec();
    const organization = await Organization.findById(
      res.body.data.organizationId,
    ).exec();

    expect(user?.firstName).toBe(firstName);
    expect(user?.lastName).toBe('{"$ne":null}');
    expect(organization?.name).toBe(organizationName);

    // The database is still intact.
    expect(await User.countDocuments()).toBe(1);
    expect(await Role.countDocuments()).toBe(1);
  });
});

describe("forgot / reset / verification / resend input validation", () => {
  it("forgot-password rejects operators, arrays, oversize, unknown fields", async () => {
    for (const body of [
      { email: { $ne: SENTINEL } },
      { email: { $gt: SENTINEL } },
      { email: [SENTINEL] },
      { email: 42 },
      { email: `${"e".repeat(310)}@example.com` },
      { email: "a@example.com", $where: SENTINEL },
      { email: "a@example.com", organizationId: SENTINEL },
      {},
    ]) {
      expectValidationError(
        await postJson("/api/auth/forgot-password", body),
        JSON.stringify(body).slice(0, 60),
      );
    }

    expect(sendResetMock).not.toHaveBeenCalled();
  });

  it("reset-password rejects bad tokens and bad passwords without touching anything", async () => {
    const good = "a".repeat(64);
    const password = "Valid-Passw0rd-123";

    for (const body of [
      { token: { $ne: SENTINEL }, newPassword: password },
      { token: [good], newPassword: password },
      { token: good.slice(0, 63), newPassword: password },
      { token: `${good}a`, newPassword: password },
      { token: "g".repeat(64), newPassword: password },
      { token: `${"a".repeat(63)}$`, newPassword: password },
      { token: good, newPassword: { $ne: SENTINEL } },
      { token: good, newPassword: [password] },
      { token: good, newPassword: "short" },
      { token: good, newPassword: "p".repeat(129) },
      { token: good, newPassword: password, userId: SENTINEL },
      { token: good, password },
      { newPassword: password },
      { token: good },
    ]) {
      expectValidationError(
        await postJson("/api/auth/reset-password", body),
        JSON.stringify(body).slice(0, 60),
      );
    }

    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("verify-email rejects operator, repeated, malformed and extra query parameters", async () => {
    const good = "a".repeat(64);

    for (const query of [
      `token[$ne]=${SENTINEL}`,
      `token[$gt]=`,
      `token[]=${good}`,
      `token=${good}&token=${good}`,
      `token=${good.slice(0, 63)}`,
      `token=${good}a`,
      `token=${"z".repeat(64)}`,
      `token=${good}&extra=1`,
      `token=`,
      ``,
    ]) {
      expectValidationError(
        await send("get", `/api/auth/verify-email?${query}`),
        query,
      );
    }
  });

  it("resend-verification rejects malformed organization ids and operators", async () => {
    const email = "a@example.com";

    for (const body of [
      { email, organizationId: "xyz" },
      { email, organizationId: "0".repeat(23) },
      { email, organizationId: "0".repeat(25) },
      { email, organizationId: "g".repeat(24) },
      { email, organizationId: { $ne: SENTINEL } },
      { email, organizationId: [SENTINEL] },
      { email: { $ne: SENTINEL }, organizationId: "0".repeat(24) },
      { email, organizationId: "0".repeat(24), extra: SENTINEL },
      { email },
      { organizationId: "0".repeat(24) },
    ]) {
      expectValidationError(
        await postJson("/api/auth/resend-verification", body),
        JSON.stringify(body).slice(0, 60),
      );
    }

    expect(sendVerificationMock).not.toHaveBeenCalled();
  });
});

describe("authenticated input validation", () => {
  it("change-password rejects operators, arrays, oversize and unknown fields", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);
    const headers = { Authorization: bearer(session.accessToken) };
    const newPassword = "Valid-Passw0rd-123";

    const before = (
      await User.findById(user.userId).select("+passwordHash").exec()
    )?.passwordHash;

    for (const body of [
      { currentPassword: { $ne: "" }, newPassword },
      { currentPassword: { $gt: "" }, newPassword },
      { currentPassword: [TEST_PASSWORD], newPassword },
      { currentPassword: 1, newPassword },
      { currentPassword: TEST_PASSWORD, newPassword: { $ne: SENTINEL } },
      { currentPassword: TEST_PASSWORD, newPassword: [newPassword] },
      { currentPassword: TEST_PASSWORD, newPassword: "short" },
      { currentPassword: TEST_PASSWORD, newPassword: "p".repeat(129) },
      { currentPassword: "c".repeat(129), newPassword },
      { currentPassword: "", newPassword },
      { currentPassword: TEST_PASSWORD, newPassword, userId: SENTINEL },
      { currentPassword: TEST_PASSWORD, newPassword, passwordHash: SENTINEL },
      { currentPassword: TEST_PASSWORD, newPassword, __proto__x: 1 },
    ]) {
      expectValidationError(
        await postJson("/api/auth/change-password", body, headers),
        JSON.stringify(body).slice(0, 70),
      );
    }

    // Nothing changed.
    const after = (
      await User.findById(user.userId).select("+passwordHash").exec()
    )?.passwordHash;

    expect(after).toBe(before);
    expect(
      (await getSessionFromDb(session.sessionId))?.revokedAt ?? null,
    ).toBeNull();
    expect(await AuditLog.countDocuments()).toBe(0);
  });

  it("change-password does not allow prototype pollution", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    await resetRateLimits();

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(session.accessToken))
      .set("Content-Type", "application/json")
      .send(
        '{"__proto__":{"isAdmin":true},"currentPassword":"x","newPassword":"Valid-Passw0rd-123"}',
      );

    expect(res.status).toBe(400);
    expect(isPolluted()).toBe(false);
  });

  it("session id parameters are strictly validated (no operators, traversal, nulls)", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);
    const headers = { Authorization: bearer(session.accessToken) };

    for (const id of [
      "xyz",
      "0".repeat(23),
      "0".repeat(25),
      "g".repeat(24),
      "%24ne",
      "%7B%22%24ne%22%3Anull%7D",
      "..%2F..%2Fetc%2Fpasswd",
      "%00",
      "null",
      "undefined",
      "a".repeat(2000),
      `${session.sessionId}x`,
    ]) {
      const res = await send(
        "delete",
        `/api/auth/sessions/${id}`,
        undefined,
        headers,
      );

      expect(res.status, id).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expectNoInternals(res.body);
    }

    // A well-formed but unknown id is a safe 404.
    const unknown = await send(
      "delete",
      `/api/auth/sessions/${"0".repeat(24)}`,
      undefined,
      headers,
    );

    expect(unknown.status).toBe(404);
    expectStandardError(unknown.body as ErrorBody, "SESSION_NOT_FOUND");

    // The caller's own session was never touched by any of the above.
    expect(
      (await getSessionFromDb(session.sessionId))?.revokedAt ?? null,
    ).toBeNull();
    expect(await Session.countDocuments({ userId: user.userId })).toBe(1);
  });

  it("GET /sessions ignores unexpected query parameters (no pagination or filter surface)", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);
    const other = await createTestUser();
    await createTestSession(other);

    const res = await request(app)
      .get("/api/auth/sessions")
      .query({
        limit: "-1",
        page: "NaN",
        skip: "9999999999",
        sort: "{$where:1}",
        "filter[$ne]": "x",
        userId: other.userId,
        organizationId: other.organizationId,
      })
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0].id).toBe(session.sessionId);
    expectNoInternals(res.body);
  });
});

describe("no raw database error ever reaches the client", () => {
  it("returns standard errors for hostile inputs across all endpoints", async () => {
    const hostile = {
      email: { $where: "sleep(5000)" },
      password: { $function: { body: "x" } },
      token: { $expr: { $eq: [1, 1] } },
      organizationId: { $lookup: { from: "users" } },
    };

    const results = [
      await postJson("/api/auth/login", hostile),
      await postJson("/api/auth/register", hostile),
      await postJson("/api/auth/forgot-password", hostile),
      await postJson("/api/auth/reset-password", hostile),
      await postJson("/api/auth/resend-verification", hostile),
      await postJson("/api/auth/refresh", hostile),
      await postJson("/api/auth/logout", hostile),
    ];

    for (const res of results) {
      expect(res.status).toBeLessThan(500);
      expectNoInternals(res.body);
      expect(res.text).not.toContain("$where");
      expect(res.text).not.toContain("$function");
      expect(res.text).not.toContain("$lookup");
    }

    expect(isPolluted()).toBe(false);
  });
});
