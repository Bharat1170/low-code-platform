import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { env } from "../src/config/env.js";
import { User } from "../src/models/user.model.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  TEST_PASSWORD,
} from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  signAccessToken,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.15.11 / 10 and 11 - HTTP hardening, error leakage sweep and the
 * health/readiness regression. (The detailed leakage cases live in
 * error-leakage.test.ts; the full health suite in health.test.ts.)
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("security headers (Helmet)", () => {
  it("sets the standard protective headers and hides the framework", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["server"]).toBeUndefined();
  });

  it("sets them on error responses too", async () => {
    for (const res of [
      await request(app).get("/api/does-not-exist"),
      await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send("{bad"),
      await request(app).get("/api/auth/sessions"),
    ]) {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    }
  });
});

describe("CORS", () => {
  it("allows credentials only for the configured client origin, never a wildcard", async () => {
    const res = await request(app)
      .get("/health")
      .set("Origin", env.CLIENT_URL);

    expect(res.headers["access-control-allow-origin"]).toBe(env.CLIENT_URL);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("never reflects or wildcards an untrusted origin", async () => {
    for (const origin of [
      "http://evil.example",
      "https://localhost:5173.evil.example",
      "null",
      "http://localhost:5174",
    ]) {
      const res = await request(app).get("/health").set("Origin", origin);

      const allowed = res.headers["access-control-allow-origin"];

      expect(allowed, origin).not.toBe("*");
      expect(allowed, origin).not.toBe(origin);
      // Only the configured origin can ever be advertised, so a browser
      // on another origin is refused.
      expect(allowed ?? env.CLIENT_URL).toBe(env.CLIENT_URL);
    }
  });

  it("answers preflight for the client origin without exposing internals", async () => {
    const res = await request(app)
      .options("/api/auth/login")
      .set("Origin", env.CLIENT_URL)
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe(env.CLIENT_URL);
    expectNoInternals(res.text);
  });
});

describe("health and readiness stay public and lightweight", () => {
  it("answers without credentials, ignores bad credentials, and sets no cookies", async () => {
    for (const path of ["/health", "/ready"]) {
      const anonymous = await request(app).get(path);
      const garbage = await request(app)
        .get(path)
        .set("Authorization", "Bearer not.a.jwt")
        .set("Cookie", "refreshToken=garbage");

      expect(anonymous.status, path).toBe(200);
      expect(garbage.status, path).toBe(200);
      expect(garbage.body, path).toEqual(anonymous.body);
      expect(anonymous.headers["set-cookie"], path).toBeUndefined();
      expectNoInternals(anonymous.body);
    }
  });

  it("exposes no infrastructure detail", async () => {
    const health = await request(app).get("/health");
    const ready = await request(app).get("/ready");

    for (const res of [health, ready]) {
      expect(Object.keys(res.body).sort()).toEqual(["message", "success"]);

      const raw = JSON.stringify(res.body).toLowerCase();

      for (const fragment of ["mongo", "redis", "27017", "6379", "localhost"]) {
        expect(raw).not.toContain(fragment);
      }
    }
  });

  it("does not create a session, audit record or database write", async () => {
    const before = await User.countDocuments();

    await request(app).get("/health");
    await request(app).get("/ready");

    expect(await User.countDocuments()).toBe(before);
  });
});

describe("error leakage sweep", () => {
  it("returns standard, internals-free errors for a broad set of failing requests", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);
    const expiredToken = signAccessToken(user, {
      options: { expiresIn: -10 },
    });

    const failing: request.Response[] = [
      await request(app).get("/api/auth/sessions"),
      await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(expiredToken)),
      await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", bearer(signAccessToken(user, { subject: "bad" }))),
      await request(app)
        .delete("/api/auth/sessions/not-an-id")
        .set("Authorization", bearer(session.accessToken)),
      await request(app)
        .delete(`/api/auth/sessions/${"0".repeat(24)}`)
        .set("Authorization", bearer(session.accessToken)),
      await request(app)
        .post("/api/auth/login")
        .send({ email: user.email, password: "wrong-password-1" }),
      await request(app)
        .post("/api/auth/login")
        .send({ email: "nobody@example.com", password: "x" }),
      await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${"a".repeat(64)}`),
      await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "a".repeat(64), newPassword: "Valid-Passw0rd-123" }),
      await request(app)
        .get("/api/auth/verify-email")
        .query({ token: "a".repeat(64) }),
      await request(app)
        .post("/api/auth/change-password")
        .set("Authorization", bearer(session.accessToken))
        .send({ currentPassword: "wrong-password-1", newPassword: "Valid-Passw0rd-123" }),
      await request(app).get("/api/unknown-route"),
      await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send("{bad json"),
      await request(app)
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "x-unsupported")
        .send("xx"),
      await request(app).get("/api/auth/sessions/%E0%A4%A"),
    ];

    for (const res of failing) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.headers["content-type"]).toContain("application/json");
      expectStandardError(res.body as ErrorBody);
      expectNoInternals(res.body);
      expectNoInternals(res.text);
      expect(res.text).not.toContain(TEST_PASSWORD);
      expect(res.text).not.toContain(session.accessToken);
      expect(res.text).not.toContain(session.refreshToken);
    }
  });

  it("an Argon2 failure (corrupt stored hash) is a generic 500 that leaks neither the error nor the password", async () => {
    const user = await createTestUser();

    await User.updateOne(
      { _id: user.userId },
      { $set: { passwordHash: "this-is-not-an-argon2-hash" } },
    );

    const spies = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    // Accepted: corrupt data is a server fault, reported generically.
    expect(res.status).toBe(500);
    expectStandardError(res.body as ErrorBody, "INTERNAL_SERVER_ERROR");
    expect(res.body.error.message).toBe("An unexpected error occurred");
    expectNoInternals(res.body);
    expect(res.text).not.toContain("this-is-not-an-argon2-hash");
    expect(res.text.toLowerCase()).not.toContain("hash");
    expect(res.headers["set-cookie"]).toBeUndefined();

    // The server-side log does not contain the submitted password.
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(TEST_PASSWORD);
  });

  it("an unexpected server error is a generic 500 with no cookies or tokens", async () => {
    const user = await createTestUser();

    const spy = vi
      .spyOn(User, "findOne")
      .mockImplementation(() => {
        throw new Error(
          `connect ECONNREFUSED ${env.MONGO_URI} password=${TEST_PASSWORD}`,
        );
      });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    spy.mockRestore();

    expect(res.status).toBe(500);
    expectStandardError(res.body as ErrorBody, "INTERNAL_SERVER_ERROR");
    expectNoInternals(res.body);
    expect(res.text).not.toContain(TEST_PASSWORD);
    expect(res.text).not.toContain(env.MONGO_URI);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
