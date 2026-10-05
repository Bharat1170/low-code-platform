import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { AUTH_CONSTANTS } from "../src/constants/auth.constants.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { Session } from "../src/models/session.model.js";
import * as emailService from "../src/services/email.service.js";
import { getProgressiveLoginDelayMs } from "../src/utils/login-security.util.js";
import { hashToken } from "../src/utils/token.util.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  TEST_PASSWORD,
} from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  type ErrorBody,
} from "./security-helpers.js";

vi.mock("../src/services/email.service.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/services/email.service.js")
    >();

  return {
    ...original,
    sendPasswordResetEmail: vi.fn(),
    sendPasswordChangedEmail: vi.fn(),
  };
});

/*
 * 8.15.11 / 7 - Rate limiting.
 *
 * The login limiter allows 20 attempts per IP and 10 per email per
 * 15 minutes, and wrong passwords add a progressive delay. Instead of
 * sending dozens of slow requests, the Redis counters are seeded to just
 * below the limit, which exercises the real limiter deterministically.
 * (The global limiter is covered in rate-limit-format.test.ts.)
 */

const WINDOW = AUTH_CONSTANTS.LOGIN_RATE_LIMIT_WINDOW_SECONDS;

const emailKey = (email: string): string =>
  `auth:login-rate:email:${hashToken(email.trim().toLowerCase())}`;

const login = (email: string, password: string) =>
  request(app).post("/api/auth/login").send({ email, password });

/*
 * Learns the IP key the server uses for supertest connections.
 */
const learnIpKey = async (): Promise<string> => {
  await login("learn-ip@example.com", "whatever-pass-1");

  const keys = await redisClient.keys("auth:login-rate:ip:*");

  expect(keys).toHaveLength(1);

  return keys[0] as string;
};

const expectRateLimited = (
  res: request.Response,
  secrets: string[] = [],
): void => {
  expect(res.status).toBe(429);
  expect(res.headers["content-type"]).toContain("application/json");
  expectStandardError(res.body as ErrorBody, "RATE_LIMIT_EXCEEDED");
  expectNoInternals(res.body);

  const retryAfter = res.headers["retry-after"];
  expect(retryAfter).toMatch(/^\d+$/);
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  expect(Number(retryAfter)).toBeLessThanOrEqual(WINDOW);

  const raw = res.text;
  expect(raw).not.toContain("redis");
  expect(raw).not.toContain("127.0.0.1");

  for (const secret of secrets) {
    expect(raw).not.toContain(secret);
  }

  expect(res.headers["set-cookie"]).toBeUndefined();
};

beforeEach(() => {
  vi.mocked(emailService.sendPasswordResetEmail).mockReset();
});

describe("login rate limiting", () => {
  it("blocks an email after the per-email limit, even with the correct password", async () => {
    const user = await createTestUser();

    await redisClient.set(
      emailKey(user.email),
      String(AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_EMAIL),
      { EX: WINDOW },
    );

    const res = await login(user.email, TEST_PASSWORD);

    expectRateLimited(res, [user.email]);

    // The credentials were never evaluated: no session, no audit, no
    // failed-attempt tracking and no delay was recorded.
    expect(await Session.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments()).toBe(0);
    expect(await redisClient.keys("auth:login-failure:*")).toHaveLength(0);
  });

  it("allows the last permitted attempt, then blocks the next", async () => {
    const user = await createTestUser();

    await redisClient.set(
      emailKey(user.email),
      String(AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_EMAIL - 1),
      { EX: WINDOW },
    );

    const allowed = await login(user.email, "wrong-password-1");
    expect(allowed.status).toBe(401);

    const blocked = await login(user.email, "wrong-password-1");
    expectRateLimited(blocked, [user.email]);
  });

  it("blocks every email from an IP that exceeded the per-IP limit", async () => {
    const ipKey = await learnIpKey();

    await redisClient.set(
      ipKey,
      String(AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP),
      { EX: WINDOW },
    );

    const user = await createTestUser();

    const res = await login(user.email, TEST_PASSWORD);

    expectRateLimited(res, [user.email]);
    expect(await Session.countDocuments()).toBe(0);
  });

  it("counts each attempt and expires the counters with the window", async () => {
    const user = await createTestUser();

    await login(user.email, "wrong-password-1");
    await login(user.email, "wrong-password-2");

    expect(await redisClient.get(emailKey(user.email))).toBe("2");

    const ttl = await redisClient.ttl(emailKey(user.email));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WINDOW);
  });

  it("normalizes the email so case and whitespace cannot dodge the limit", async () => {
    const user = await createTestUser();

    await redisClient.set(
      emailKey(user.email),
      String(AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_EMAIL),
      { EX: WINDOW },
    );

    const res = await login(
      `  ${user.email.toUpperCase()}  `,
      TEST_PASSWORD,
    );

    expectRateLimited(res);
  });

  it("does not let one email's limit block a different account", async () => {
    const blocked = await createTestUser();
    const other = await createTestUser();

    await redisClient.set(
      emailKey(blocked.email),
      String(AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_EMAIL),
      { EX: WINDOW },
    );

    expectRateLimited(await login(blocked.email, TEST_PASSWORD));

    const ok = await login(other.email, TEST_PASSWORD);
    expect(ok.status).toBe(200);
  });

  it("stores only hashed identifiers in Redis", async () => {
    const user = await createTestUser();

    await login(user.email, "wrong-password-1");

    for (const key of await redisClient.keys("auth:*")) {
      expect(key).not.toContain(user.email);
      expect(key).not.toContain("127.0.0.1");
      expect(key).not.toContain("::1");
    }
  });

  it("rate-limits before validation, so malformed floods are throttled too", async () => {
    const ipKey = await learnIpKey();

    await redisClient.set(
      ipKey,
      String(AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP),
      { EX: WINDOW },
    );

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: { $ne: "" }, password: "x" });

    expectRateLimited(res);
  });
});

describe("progressive login delay", () => {
  it("is zero for the first two failures, then doubles up to a cap", () => {
    const base = AUTH_CONSTANTS.LOGIN_PROGRESSIVE_DELAY_BASE_MS;
    const max = AUTH_CONSTANTS.LOGIN_PROGRESSIVE_DELAY_MAX_MS;

    expect(getProgressiveLoginDelayMs(0)).toBe(0);
    expect(getProgressiveLoginDelayMs(1)).toBe(0);
    expect(getProgressiveLoginDelayMs(2)).toBe(0);
    expect(getProgressiveLoginDelayMs(3)).toBe(base);
    expect(getProgressiveLoginDelayMs(4)).toBe(base * 2);
    expect(getProgressiveLoginDelayMs(5)).toBe(base * 4);

    for (const attempts of [6, 10, 50, 10_000]) {
      expect(getProgressiveLoginDelayMs(attempts)).toBeLessThanOrEqual(
        max,
      );
    }

    expect(getProgressiveLoginDelayMs(10_000)).toBe(max);
  });
});

describe("rate-limit responses of the password endpoints", () => {
  it("forgot-password: standard 429 with Retry-After, no email or account data", async () => {
    const statuses: number[] = [];
    let last: request.Response | undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email: `flood-${attempt}@example.com` });

      statuses.push(last.status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expectRateLimited(last as request.Response, ["flood-5@example.com"]);
  });

  it("forgot-password: the per-email limit hides account existence", async () => {
    const user = await createTestUser();
    const email = user.email;

    const keyOf = (value: string) =>
      `auth:forgot-password-rate:email:${hashToken(value)}`;

    await redisClient.set(
      keyOf(email),
      String(AUTH_CONSTANTS.FORGOT_PASSWORD_MAX_ATTEMPTS_PER_EMAIL),
      { EX: WINDOW },
    );
    await redisClient.set(
      keyOf("nobody@example.com"),
      String(AUTH_CONSTANTS.FORGOT_PASSWORD_MAX_ATTEMPTS_PER_EMAIL),
      { EX: WINDOW },
    );

    const known = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email });
    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "nobody@example.com" });

    expectRateLimited(known, [email]);
    expectRateLimited(unknown, ["nobody@example.com"]);
    expect(known.body).toEqual(unknown.body);
  });

  it("reset-password: standard 429 with Retry-After", async () => {
    const statuses: number[] = [];
    let last: request.Response | undefined;

    for (let attempt = 0; attempt < 11; attempt += 1) {
      last = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "c".repeat(64), newPassword: "Valid-Passw0rd-123" });

      statuses.push(last.status);
    }

    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(
      true,
    );
    expect(statuses[10]).toBe(429);
    expectRateLimited(last as request.Response, ["c".repeat(64)]);
  });

  it("change-password: standard 429 with Retry-After, keyed on the JWT user", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const statuses: number[] = [];
    let last: request.Response | undefined;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await request(app)
        .post("/api/auth/change-password")
        .set("Authorization", bearer(session.accessToken))
        .send({
          currentPassword: "wrong-password-1",
          newPassword: "Valid-Passw0rd-123",
        });

      statuses.push(last.status);
    }

    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    expectRateLimited(last as request.Response, [
      "wrong-password-1",
      user.email,
    ]);

    // The limiter key is the hashed user id, never the raw id.
    for (const key of await redisClient.keys("auth:change-password-rate:*")) {
      expect(key).not.toContain(user.userId);
    }
  });

  it("change-password: unauthenticated requests are rejected before consuming the user's budget", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const res = await request(app)
        .post("/api/auth/change-password")
        .send({
          currentPassword: "x",
          newPassword: "Valid-Passw0rd-123",
        });

      expect(res.status).toBe(401);
    }

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", bearer(session.accessToken))
      .send({
        currentPassword: "wrong-password-1",
        newPassword: "Valid-Passw0rd-123",
      });

    expect(res.status).toBe(400);
  });
});
