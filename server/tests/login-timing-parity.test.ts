import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import * as passwordUtil from "../src/utils/password.util.js";

import { createTestUser } from "./helpers.js";

vi.mock("../src/utils/password.util.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../src/utils/password.util.js")
    >();

  return {
    ...original,
    verifyPassword: vi.fn(original.verifyPassword),
    verifyPasswordAgainstDummyHash: vi.fn(
      original.verifyPasswordAgainstDummyHash,
    ),
  };
});

const verifyMock = vi.mocked(passwordUtil.verifyPassword);
const dummyMock = vi.mocked(passwordUtil.verifyPasswordAgainstDummyHash);

beforeEach(() => {
  verifyMock.mockClear();
  dummyMock.mockClear();
});

describe("login does the same password work for known and unknown emails", () => {
  it("verifies against a dummy hash when the email is unknown", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "whatever-pass-1" });

    expect(res.status).toBe(401);
    expect(dummyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("verifies against the real hash (and not the dummy) when the email is known", async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: user.email, password: "wrong-password-1" });

    expect(res.status).toBe(401);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(dummyMock).not.toHaveBeenCalled();
  });

  it("the dummy verification never accepts a password", async () => {
    const original = await vi.importActual<
      typeof import("../src/utils/password.util.js")
    >("../src/utils/password.util.js");

    await expect(
      original.verifyPasswordAgainstDummyHash("any-password"),
    ).resolves.toBeUndefined();
  });
});
