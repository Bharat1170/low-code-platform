import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { env } from "../src/config/env.js";
import { Organization } from "../src/models/organization.model.js";
import { Session } from "../src/models/session.model.js";
import { User } from "../src/models/user.model.js";
import {
  clearRefreshTokenCookie,
  setRefreshTokenCookie,
} from "../src/utils/auth-cookie.util.js";
import { hashToken } from "../src/utils/token.util.js";

import {
  createTestSession,
  createTestUser,
  getSetCookies,
  TEST_PASSWORD,
} from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
} from "./security-helpers.js";

/*
 * 8.15.11 / 2 - Refresh-token security.
 */

const refreshWith = (token: string) =>
  request(app)
    .post("/api/auth/refresh")
    .set("Cookie", `refreshToken=${token}`);

const refreshCookieOf = (headers: {
  [key: string]: unknown;
}): { value: string; raw: string } => {
  for (const raw of getSetCookies(headers)) {
    const match = /^refreshToken=([^;]*);/.exec(raw);

    if (match) {
      return { value: match[1] ?? "", raw };
    }
  }

  throw new Error("No refresh cookie was set");
};

const activeSessionsOf = (userId: string) =>
  Session.find({ userId, revokedAt: null }).exec();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refresh-token rotation", () => {
  it("rotates: a new token and session are issued and the old session is revoked", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const before = await Session.findById(original.sessionId)
      .select("+refreshTokenHash")
      .exec();

    const res = await refreshWith(original.refreshToken);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeTypeOf("string");

    const rotated = refreshCookieOf(res.headers);

    expect(rotated.value).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.value).not.toBe(original.refreshToken);

    const old = await Session.findById(original.sessionId).exec();
    expect(old?.revokedAt).toBeInstanceOf(Date);

    const active = await activeSessionsOf(user.userId);
    expect(active).toHaveLength(1);
    expect(active[0]?._id.toString()).not.toBe(original.sessionId);

    // Same family, same fixed expiry.
    expect(active[0]?.tokenFamilyId).toBe(before?.tokenFamilyId);
    expect(active[0]?.expiresAt.getTime()).toBe(
      before?.expiresAt.getTime(),
    );
  });

  it("stores only the hash of the new refresh token", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const res = await refreshWith(original.refreshToken);
    const { value } = refreshCookieOf(res.headers);

    const stored = await Session.find({ userId: user.userId })
      .select("+refreshTokenHash")
      .lean()
      .exec();

    const raw = JSON.stringify(stored);

    expect(raw).not.toContain(value);
    expect(raw).not.toContain(original.refreshToken);
    expect(
      stored.some((s) => s.refreshTokenHash === hashToken(value)),
    ).toBe(true);
  });

  it("returns the refresh token only in the cookie, never in the body", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const res = await refreshWith(original.refreshToken);
    const { value } = refreshCookieOf(res.headers);

    const body = JSON.stringify(res.body);

    expect(body).not.toContain(value);
    expect(body).not.toContain(original.refreshToken);
    expect(body).not.toContain(hashToken(value));
    expect(body).not.toContain("refreshToken");
    expect(body).not.toContain("refreshTokenHash");
    expect(Object.keys(res.body.data).sort()).toEqual([
      "accessToken",
      "expiresAt",
    ]);
  });

  it("login returns the refresh token only in the cookie, never in the body", async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);

    const { value } = refreshCookieOf(res.headers);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain(value);
    expect(body).not.toContain(hashToken(value));
    expect(body).not.toContain("refreshToken");
    expect(body).not.toContain("passwordHash");
  });

  it("issues an access token bound to the NEW session", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const res = await refreshWith(original.refreshToken);
    const newAccessToken = res.body.data.accessToken as string;

    const list = await request(app)
      .get("/api/auth/sessions")
      .set("Authorization", `Bearer ${newAccessToken}`);

    expect(list.status).toBe(200);
    expect(list.body.data.sessions).toHaveLength(1);
    expect(list.body.data.sessions[0].current).toBe(true);
    expect(list.body.data.sessions[0].id).not.toBe(original.sessionId);
  });

  it("only reads the refresh token from the cookie (not body, query or headers)", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const res = await request(app)
      .post("/api/auth/refresh")
      .query({ refreshToken: original.refreshToken })
      .set("X-Refresh-Token", original.refreshToken)
      .set("Authorization", `Bearer ${original.refreshToken}`)
      .send({ refreshToken: original.refreshToken });

    expect(res.status).toBe(401);
    expect(
      (await Session.findById(original.sessionId).exec())?.revokedAt ??
        null,
    ).toBeNull();
  });
});

describe("refresh-token failures", () => {
  it("never echo the submitted token or its hash, and never set a cookie", async () => {
    const user = await createTestUser();

    const unknownToken = "d".repeat(64);

    const expired = await createTestSession(user);
    await Session.updateOne(
      { _id: expired.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const revoked = await createTestSession(user);
    await Session.updateOne(
      { _id: revoked.sessionId },
      { $set: { revokedAt: new Date() } },
    );

    for (const token of [
      unknownToken,
      expired.refreshToken,
      revoked.refreshToken,
      "short",
      "x".repeat(5000),
      "%00%0d%0a",
    ]) {
      const res = await refreshWith(token);

      expect(res.status).toBe(401);
      expectStandardError(res.body, "INVALID_REFRESH_TOKEN");
      expectNoInternals(res.body);

      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(token);
      expect(raw).not.toContain(hashToken(token));
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("rejects an expired refresh token without rotating it", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    await Session.updateOne(
      { _id: session.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const res = await refreshWith(session.refreshToken);

    expect(res.status).toBe(401);
    expect(await Session.countDocuments({ userId: user.userId })).toBe(1);
  });

  it("rejects a token revoked by logout", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${session.refreshToken}`);

    expect(logout.status).toBe(200);

    const res = await refreshWith(session.refreshToken);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("does not issue tokens for an inactive user or organization, and does not rotate", async () => {
    const cases: Array<
      [string, (user: { userId: string; organizationId: string }) => Promise<unknown>]
    > = [
      [
        "suspended user",
        (u) =>
          User.updateOne({ _id: u.userId }, { $set: { status: "SUSPENDED" } }),
      ],
      [
        "deleted user",
        (u) =>
          User.updateOne({ _id: u.userId }, { $set: { status: "DELETED" } }),
      ],
      [
        "suspended organization",
        (u) =>
          Organization.updateOne(
            { _id: u.organizationId },
            { $set: { status: "SUSPENDED" } },
          ),
      ],
      [
        "deleted organization",
        (u) =>
          Organization.updateOne(
            { _id: u.organizationId },
            { $set: { status: "DELETED" } },
          ),
      ],
    ];

    for (const [name, deactivate] of cases) {
      const user = await createTestUser();
      const session = await createTestSession(user);

      await deactivate(user);

      const res = await refreshWith(session.refreshToken);

      expect(res.status, name).toBe(403);
      expectStandardError(res.body, "ACCOUNT_NOT_ACTIVE");
      expect(res.body.data?.accessToken, name).toBeUndefined();
      expect(res.headers["set-cookie"], name).toBeUndefined();
      expect(
        (await Session.findById(session.sessionId).exec())?.revokedAt ??
          null,
        name,
      ).toBeNull();
    }
  });

  it("does not expose a Mongo or internal error for a very long or odd cookie value", async () => {
    for (const value of ["a".repeat(7000), "$ne", "{}", "[]", "%"]) {
      const res = await request(app)
        .post("/api/auth/refresh")
        .set("Cookie", `refreshToken=${value}`);

      expect(res.status).toBeLessThan(500);
      expectNoInternals(res.body);
    }
  });
});

describe("refresh-token reuse detection", () => {
  it("revokes the entire token family when an old token is replayed after several rotations", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const r1 = await refreshWith(original.refreshToken);
    const t1 = refreshCookieOf(r1.headers).value;

    const r2 = await refreshWith(t1);
    const t2 = refreshCookieOf(r2.headers).value;

    const r3 = await refreshWith(t2);
    const t3 = refreshCookieOf(r3.headers).value;

    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
    expect(await activeSessionsOf(user.userId)).toHaveLength(1);

    // Replaying the very first token is an attack signal.
    const replay = await refreshWith(original.refreshToken);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    expect(await activeSessionsOf(user.userId)).toHaveLength(0);

    // The legitimate latest token is dead too.
    const latest = await refreshWith(t3);
    expect(latest.status).toBe(401);
  });

  it("only revokes the replayed token's family, not the user's other logins", async () => {
    const user = await createTestUser();

    const laptop = await createTestSession(user);
    const phone = await createTestSession(user);

    const rotated = await refreshWith(laptop.refreshToken);
    expect(rotated.status).toBe(200);

    const replay = await refreshWith(laptop.refreshToken);
    expect(replay.status).toBe(401);

    const phoneRefresh = await refreshWith(phone.refreshToken);
    expect(phoneRefresh.status).toBe(200);
  });

  it("a replay response does not reveal that reuse was detected", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    await refreshWith(original.refreshToken);

    const replay = await refreshWith(original.refreshToken);
    const unknown = await refreshWith("e".repeat(64));

    expect(replay.status).toBe(unknown.status);
    expect(replay.body).toEqual(unknown.body);
  });
});

describe("concurrent refresh", () => {
  it("never issues more than one new session from the same token", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => refreshWith(original.refreshToken)),
    );

    const successes = results.filter((res) => res.status === 200);

    // The refresh token is single-use: at most one request can win.
    expect(successes.length).toBeLessThanOrEqual(1);

    for (const res of results) {
      if (res.status !== 200) {
        // Refused requests are generic and leak nothing. (A rare write
        // race can surface as the generic 500; never anything else.)
        expect([401, 500]).toContain(res.status);
        expectNoInternals(res.body);
        expect(res.body.data?.accessToken).toBeUndefined();
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
    }

    // However the race resolved, there is never more than one live
    // session, and the original token is spent.
    expect(
      (await activeSessionsOf(user.userId)).length,
    ).toBeLessThanOrEqual(1);
    expect((await refreshWith(original.refreshToken)).status).toBe(401);
  });
});

describe("refresh cookie attributes", () => {
  it("is HttpOnly, SameSite=Lax, scoped to /api/auth and expires with the session", async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });

    const { raw } = refreshCookieOf(res.headers);

    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Path=/api/auth");
    expect(raw).toMatch(/Max-Age=604800/);
    expect(raw).toMatch(/Expires=/);
  });

  it("is rotated with the same attributes on refresh", async () => {
    const user = await createTestUser();
    const original = await createTestSession(user);

    const res = await refreshWith(original.refreshToken);
    const { raw } = refreshCookieOf(res.headers);

    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Path=/api/auth");
  });

  it("is cleared with matching attributes on logout", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${session.refreshToken}`);

    const { raw, value } = refreshCookieOf(res.headers);

    expect(value).toBe("");
    expect(raw).toContain("Path=/api/auth");
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it("is Secure in production and not otherwise", () => {
    const original = env.NODE_ENV;

    const fakeResponse = () => {
      const cookie = vi.fn();
      const clearCookie = vi.fn();

      return {
        res: { cookie, clearCookie } as unknown as Parameters<
          typeof setRefreshTokenCookie
        >[0],
        cookie,
        clearCookie,
      };
    };

    try {
      (env as { NODE_ENV: string }).NODE_ENV = "production";

      const prod = fakeResponse();
      setRefreshTokenCookie(prod.res, "token-value");
      clearRefreshTokenCookie(prod.res);

      expect(prod.cookie).toHaveBeenCalledWith(
        "refreshToken",
        "token-value",
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/api/auth",
          maxAge: 7 * 24 * 60 * 60 * 1000,
        }),
      );
      expect(prod.clearCookie).toHaveBeenCalledWith(
        "refreshToken",
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/api/auth",
        }),
      );

      (env as { NODE_ENV: string }).NODE_ENV = "development";

      const dev = fakeResponse();
      setRefreshTokenCookie(dev.res, "token-value");

      expect(dev.cookie).toHaveBeenCalledWith(
        "refreshToken",
        "token-value",
        expect.objectContaining({ httpOnly: true, secure: false }),
      );
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = original;
    }
  });
});
