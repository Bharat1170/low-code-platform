import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { User } from "../src/models/user.model.js";

import {
  bearer,
  createTestSession,
  createTestUser,
} from "./helpers.js";

describe("GET /api/auth/me", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the authenticated user and organization, without secrets", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      id: user.userId,
      email: user.email,
      organizationId: user.organizationId,
    });
    expect(res.body.data.organization.id).toBe(user.organizationId);
    expect(typeof res.body.data.organization.name).toBe("string");

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/passwordHash|refreshToken/i);
  });

  it("does not return another user's data", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const sessionA = await createTestSession(a);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", bearer(sessionA.accessToken));

    expect(res.body.data.user.id).toBe(a.userId);
    expect(JSON.stringify(res.body)).not.toContain(b.email);
  });

  it("rejects a token whose user is no longer active", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);
    await User.updateOne({ _id: user.userId }, { status: "SUSPENDED" });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(401);
  });
});
