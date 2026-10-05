import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";

describe("centralized error handling", () => {
  it("returns a standard 400 for an invalid login body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("Invalid request");
    expect(res.body.error.fields.email).toBeDefined();
    expect(res.body.error.fields.password).toBeDefined();
  });

  it("returns a standard 400 for an invalid registration body", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "nope" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.fields.firstName).toBeDefined();
  });

  it("rejects unexpected fields on strict schemas", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: "user@example.com",
      password: "whatever",
      isAdmin: true,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns a standard 400 for malformed JSON", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{ not json");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});
