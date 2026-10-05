import { describe, expect, it } from "vitest";
import { readReturnTo } from "../routing/return-to.ts";
import { validateLogin, validateRegister } from "./auth.validation.ts";

const valid = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  password: "Correct-Horse-9",
  organizationName: "Analytical Engines",
};

describe("validateRegister (mirrors the backend rules)", () => {
  it("accepts valid input", () => {
    expect(validateRegister(valid)).toEqual({});
  });

  it("requires every field", () => {
    const errors = validateRegister({
      firstName: " ",
      lastName: "",
      email: "",
      password: "",
      organizationName: "",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "email",
      "firstName",
      "lastName",
      "organizationName",
      "password",
    ]);
  });

  it("enforces password length 8..128", () => {
    expect(validateRegister({ ...valid, password: "short" }).password).toMatch(/at least 8/);
    expect(validateRegister({ ...valid, password: "x".repeat(129) }).password).toMatch(/exceed 128/);
    expect(validateRegister({ ...valid, password: "x".repeat(8) }).password).toBeUndefined();
  });

  it("enforces organization name of at least 2 characters", () => {
    expect(validateRegister({ ...valid, organizationName: "A" }).organizationName).toMatch(
      /at least 2/,
    );
  });

  it("rejects malformed emails", () => {
    for (const email of ["nope", "a@b", "a b@c.com", "@c.com"]) {
      expect(validateRegister({ ...valid, email }).email).toBeTruthy();
    }
  });
});

describe("validateLogin", () => {
  it("requires email and password but not the registration password policy", () => {
    expect(validateLogin({ email: "", password: "" })).toHaveProperty("email");
    expect(validateLogin({ email: "", password: "" })).toHaveProperty("password");
    expect(validateLogin({ email: "a@b.co", password: "x" })).toEqual({});
  });
});

describe("readReturnTo", () => {
  it("keeps same-app paths including the query string", () => {
    expect(readReturnTo({ from: "/?formId=abc" })).toBe("/?formId=abc");
  });

  it("rejects external, protocol-relative and auth-page targets", () => {
    for (const from of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/login",
      "/register",
      42,
      undefined,
    ]) {
      expect(readReturnTo({ from })).toBe("/");
    }
    expect(readReturnTo(null)).toBe("/");
  });
});
