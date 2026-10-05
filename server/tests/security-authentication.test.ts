import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { env } from "../src/config/env.js";

import { bearer, createTestUser, objectId } from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  signAccessToken,
} from "./security-helpers.js";

/*
 * 8.15.11 / 1 - Authentication.
 *
 * Account-status and organization-mismatch behavior of the guards is
 * covered in authorization.test.ts and password-change.test.ts. These
 * tests cover the token itself, on real production routes.
 */

const PROTECTED = [
  { method: "get", path: "/api/auth/sessions" },
  { method: "delete", path: "/api/auth/sessions" },
  { method: "post", path: "/api/auth/change-password" },
] as const;

const call = (
  method: "get" | "delete" | "post",
  path: string,
  authorization?: string,
) => {
  const req = request(app)[method](path);

  if (authorization !== undefined) {
    req.set("Authorization", authorization);
  }

  if (method === "post") {
    req.send({
      currentPassword: "Correct-Horse-Battery-9",
      newPassword: "Another-Passw0rd-123",
    });
  }

  return req;
};

const UNAUTHENTICATED_BODY = {
  success: false,
  error: {
    code: "UNAUTHORIZED",
    message: "Invalid or expired access token",
    fields: {},
  },
};

describe("access token verification", () => {
  it("rejects a missing token on every protected route with the standard 401", async () => {
    for (const { method, path } of PROTECTED) {
      const res = await call(method, path);

      expect(res.status).toBe(401);
      expectStandardError(res.body, "UNAUTHORIZED");
      expectNoInternals(res.body);
    }
  });

  it("rejects malformed Authorization headers", async () => {
    for (const header of [
      "",
      "Bearer",
      "Bearer ",
      "Bearer a b",
      "bearer-only",
      "Basic dXNlcjpwYXNz",
      "Token abc",
      `Bearer ${"a".repeat(10_000)}`,
      "Bearer not.a.jwt",
      "Bearer a.b",
      "Bearer ..",
    ]) {
      const res = await call("get", "/api/auth/sessions", header);

      expect(res.status).toBe(401);
      expectStandardError(res.body, "UNAUTHORIZED");
      expectNoInternals(res.body);
    }
  });

  it("gives every kind of invalid token the identical response (no oracle)", async () => {
    const user = await createTestUser();

    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.userId,
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "access",
      }),
    ).toString("base64url");

    const valid = signAccessToken(user);

    const tokens = {
      expired: signAccessToken(user, {
        options: { expiresIn: -10 },
      }),
      notYetValid: signAccessToken(user, {
        options: { notBefore: 3600 },
      }),
      wrongSecret: signAccessToken(user, {
        secret: "a-completely-different-secret-0123456789abcdef",
      }),
      wrongAlgorithm: signAccessToken(user, {
        options: { algorithm: "HS512" },
      }),
      algNone: `${header}.${payload}.`,
      tampered: `${valid.slice(0, -4)}AAAA`,
      refreshType: signAccessToken(user, { claims: { type: "refresh" } }),
    };

    for (const [name, token] of Object.entries(tokens)) {
      const res = await call(
        "get",
        "/api/auth/sessions",
        bearer(token),
      );

      expect(res.status, name).toBe(401);
      expect(res.body, name).toEqual(UNAUTHENTICATED_BODY);
    }
  });

  it("rejects validly signed tokens with invalid or missing claims (401, never 500)", async () => {
    const user = await createTestUser();

    const bad: Record<string, string> = {
      "non-ObjectId sub": signAccessToken(user, { subject: "abc" }),
      "sub with operator-like text": signAccessToken(user, {
        subject: '{"$ne":1}',
      }),
      "short sub": signAccessToken(user, { subject: "a".repeat(23) }),
      "long sub": signAccessToken(user, { subject: "a".repeat(25) }),
      "non-ObjectId organizationId": signAccessToken(user, {
        claims: { organizationId: "xyz" },
      }),
      "non-ObjectId sessionId": signAccessToken(user, {
        claims: { sessionId: "zzz" },
      }),
      "missing sub": signAccessToken(user, { subject: null }),
      "missing organizationId": signAccessToken(user, {
        claims: { organizationId: undefined },
      }),
      "missing sessionId": signAccessToken(user, {
        claims: { sessionId: undefined },
      }),
      "missing type": signAccessToken(user, {
        claims: { type: undefined },
      }),
      "numeric sub": jwt.sign(
        {
          sub: 123,
          organizationId: user.organizationId,
          sessionId: objectId(),
          type: "access",
        },
        env.JWT_ACCESS_SECRET,
        { algorithm: "HS256" },
      ),
      "object organizationId": signAccessToken(user, {
        claims: { organizationId: { $ne: 1 } },
      }),
      "array sessionId": signAccessToken(user, {
        claims: { sessionId: [objectId()] },
      }),
      "null organizationId": signAccessToken(user, {
        claims: { organizationId: null },
      }),
    };

    for (const [name, token] of Object.entries(bad)) {
      for (const { method, path } of PROTECTED) {
        const res = await call(method, path, bearer(token));

        expect(res.status, `${name} -> ${path}`).toBe(401);
        expect(res.body, `${name} -> ${path}`).toEqual(
          UNAUTHENTICATED_BODY,
        );
      }
    }
  });

  it("does not leak JWT library errors, claims or secrets in any failure", async () => {
    const user = await createTestUser();

    const attempts = [
      signAccessToken(user, { options: { expiresIn: -10 } }),
      signAccessToken(user, { subject: "abc" }),
      signAccessToken(user, {
        secret: "a-completely-different-secret-0123456789abcdef",
      }),
      "Bearer-less garbage",
    ];

    for (const token of attempts) {
      const res = await call(
        "get",
        "/api/auth/sessions",
        bearer(token),
      );

      expectNoInternals(res.body);
      expect(JSON.stringify(res.body)).not.toContain(user.userId);
      expect(JSON.stringify(res.body)).not.toContain(
        user.organizationId,
      );
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain(
        "signature",
      );
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain(
        "expired at",
      );
    }
  });

  it("does not set cookies or headers that reveal the failure", async () => {
    const res = await call(
      "get",
      "/api/auth/sessions",
      bearer("not.a.jwt"),
    );

    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["www-authenticate"]).toBeUndefined();
  });

  it("does not accept the access token from a cookie, query string or body", async () => {
    const user = await createTestUser();
    const token = signAccessToken(user);

    const viaCookie = await request(app)
      .get("/api/auth/sessions")
      .set("Cookie", `accessToken=${token}; token=${token}`);

    const viaQuery = await request(app)
      .get("/api/auth/sessions")
      .query({ accessToken: token, token, access_token: token });

    const viaBody = await request(app)
      .get("/api/auth/sessions")
      .send({ accessToken: token, token });

    for (const res of [viaCookie, viaQuery, viaBody]) {
      expect(res.status).toBe(401);
    }
  });

  it("does not accept a refresh token as an access token", async () => {
    const res = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", bearer("a".repeat(64)));

    expect(res.status).toBe(401);
  });
});
