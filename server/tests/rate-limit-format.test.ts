import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";

/*
 * Kept in its own file: the global limiter is in-memory and shared by
 * every request in a test file, so exhausting it would affect others.
 */
describe("global rate limiter response", () => {
  it("returns the standard JSON error format when the limit is exceeded", async () => {
    let last: request.Response | undefined;
    let firstLimited: number | undefined;

    for (let attempt = 1; attempt <= 305; attempt += 1) {
      last = await request(app).get("/health");

      if (last.status === 429 && firstLimited === undefined) {
        firstLimited = attempt;
      }
    }

    // 300 requests per window are allowed.
    expect(firstLimited).toBe(301);

    expect(last?.status).toBe(429);
    expect(last?.headers["content-type"]).toContain("application/json");
    expect(last?.body).toEqual({
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests. Please try again later.",
        fields: {},
      },
    });
    expect(last?.text).not.toContain("<html");
  }, 120000);
});
