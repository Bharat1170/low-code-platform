import { describe, expect, it } from "vitest";

import {
  createFormSchema,
  updateFormSchema,
} from "../src/validators/form.validator.js";

import { objectId } from "./helpers.js";

/*
 * 8.17.2 — Form validator unit tests (schemas only, no HTTP).
 */

const validCreate = (): Record<string, unknown> => ({
  name: "Contact Form",
  description: "Collects contact details",
  slug: "contact-form",
  status: "DRAFT",
  projectId: objectId(),
});

const without = (field: string): Record<string, unknown> => {
  const copy = validCreate();
  delete copy[field];
  return copy;
};

// JSON.parse creates a real own "__proto__" key, as an HTTP body would.
const json = (text: string): unknown => JSON.parse(text);

describe("createFormSchema", () => {
  it("accepts valid input", () => {
    const input = validCreate();
    const result = createFormSchema.safeParse(input);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(input);
  });

  it("allows description to be omitted without inventing a value", () => {
    const result = createFormSchema.safeParse(without("description"));

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("description");
  });

  it("trims the name", () => {
    const result = createFormSchema.safeParse({
      ...validCreate(),
      name: "  Padded  ",
    });

    expect(result.data?.name).toBe("Padded");
  });

  it("trims the description", () => {
    const result = createFormSchema.safeParse({
      ...validCreate(),
      description: "  text  ",
    });

    expect(result.data?.description).toBe("text");
  });

  it("trims and lowercases the slug", () => {
    const result = createFormSchema.safeParse({
      ...validCreate(),
      slug: "  My-Form  ",
    });

    expect(result.data?.slug).toBe("my-form");
  });

  it("trims and uppercases the status", () => {
    const result = createFormSchema.safeParse({
      ...validCreate(),
      status: "  published ",
    });

    expect(result.data?.status).toBe("PUBLISHED");
  });

  it.each(["DRAFT", "PUBLISHED", "ARCHIVED", "archived"])(
    "accepts status %s",
    (status) => {
      expect(
        createFormSchema.safeParse({ ...validCreate(), status }).success,
      ).toBe(true);
    },
  );

  it("accepts a valid projectId (upper or lower case hex)", () => {
    const id = objectId();

    expect(
      createFormSchema.safeParse({ ...validCreate(), projectId: id })
        .success,
    ).toBe(true);
    expect(
      createFormSchema.safeParse({
        ...validCreate(),
        projectId: id.toUpperCase(),
      }).success,
    ).toBe(true);
  });

  it.each([
    "not-an-id",
    "123",
    "z".repeat(24),
    "a".repeat(23),
    "a".repeat(25),
    "",
    "   ",
  ])("rejects invalid projectId %j", (projectId) => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), projectId }).success,
    ).toBe(false);
  });

  it.each([
    "has space",
    "has_underscore",
    "-leading",
    "trailing-",
    "double--hyphen",
    "UPPER case",
    "slash/slug",
    "",
    "   ",
  ])("rejects invalid slug %j", (slug) => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), slug }).success,
    ).toBe(false);
  });

  it("enforces length limits", () => {
    const base = validCreate();

    expect(
      createFormSchema.safeParse({ ...base, name: "n".repeat(150) })
        .success,
    ).toBe(true);
    expect(
      createFormSchema.safeParse({ ...base, name: "n".repeat(151) })
        .success,
    ).toBe(false);
    expect(
      createFormSchema.safeParse({ ...base, description: "d".repeat(500) })
        .success,
    ).toBe(true);
    expect(
      createFormSchema.safeParse({ ...base, description: "d".repeat(501) })
        .success,
    ).toBe(false);
    expect(
      createFormSchema.safeParse({ ...base, slug: "s".repeat(150) })
        .success,
    ).toBe(true);
    expect(
      createFormSchema.safeParse({ ...base, slug: "s".repeat(151) })
        .success,
    ).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), name: "   " })
        .success,
    ).toBe(false);
  });

  it.each(["name", "slug", "status", "projectId"])(
    "rejects a missing %s",
    (field) => {
      expect(createFormSchema.safeParse(without(field)).success).toBe(
        false,
      );
    },
  );

  it("rejects an empty object", () => {
    expect(createFormSchema.safeParse({}).success).toBe(false);
  });

  it.each(["ACTIVE", "published!", "DRAFTS", "", "   "])(
    "rejects invalid status %j",
    (status) => {
      expect(
        createFormSchema.safeParse({ ...validCreate(), status }).success,
      ).toBe(false);
    },
  );

  it.each([
    "organizationId",
    "createdBy",
    "_id",
    "createdAt",
    "updatedAt",
  ])("rejects protected field %s", (field) => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), [field]: objectId() })
        .success,
    ).toBe(false);
  });

  it.each(["randomField", "prototype", "constructor", "$where", "$set"])(
    "rejects unknown field %s",
    (field) => {
      expect(
        createFormSchema.safeParse({ ...validCreate(), [field]: "x" })
          .success,
      ).toBe(false);
    },
  );

  it("rejects $where and $set operator payloads", () => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), $where: "1==1" })
        .success,
    ).toBe(false);
    expect(
      createFormSchema.safeParse({
        ...validCreate(),
        $set: { organizationId: objectId() },
      }).success,
    ).toBe(false);
  });

  it("rejects an own __proto__ key", () => {
    const body = json(
      `{"name":"n","slug":"s","status":"DRAFT","projectId":"${objectId()}","__proto__":{"admin":true}}`,
    );

    expect(createFormSchema.safeParse(body).success).toBe(false);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("rejects constructor.prototype payloads", () => {
    const body = json(
      `{"name":"n","slug":"s","status":"DRAFT","projectId":"${objectId()}","constructor":{"prototype":{"admin":true}}}`,
    );

    expect(createFormSchema.safeParse(body).success).toBe(false);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it.each([
    ["name", { $ne: "" }],
    ["description", { $gt: "" }],
    ["slug", { $ne: null }],
    ["status", { $gt: "" }],
    ["projectId", { $ne: null }],
  ])("rejects an operator object for %s", (field, value) => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), [field]: value })
        .success,
    ).toBe(false);
  });

  it.each([
    ["name", 123],
    ["description", ["a"]],
    ["slug", true],
    ["status", null],
    ["projectId", 123],
  ])("rejects a non-string %s", (field, value) => {
    expect(
      createFormSchema.safeParse({ ...validCreate(), [field]: value })
        .success,
    ).toBe(false);
  });
});

describe("updateFormSchema", () => {
  it("rejects an empty object", () => {
    expect(updateFormSchema.safeParse({}).success).toBe(false);
  });

  it.each([
    ["name", "New Name"],
    ["description", "New description"],
    ["slug", "new-slug"],
    ["status", "ARCHIVED"],
    ["projectId", objectId()],
  ])("accepts a partial update of only %s", (field, value) => {
    const result = updateFormSchema.safeParse({ [field]: value });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ [field]: value });
  });

  it("accepts all fields together", () => {
    expect(updateFormSchema.safeParse(validCreate()).success).toBe(true);
  });

  it("normalizes values like create", () => {
    const result = updateFormSchema.safeParse({
      name: "  Renamed ",
      description: " d ",
      slug: "  New-Slug ",
      status: " archived ",
    });

    expect(result.data).toEqual({
      name: "Renamed",
      description: "d",
      slug: "new-slug",
      status: "ARCHIVED",
    });
  });

  it.each([
    ["an invalid status", { status: "ACTIVE" }],
    ["an invalid slug", { slug: "Bad Slug!" }],
    ["an invalid projectId", { projectId: "nope" }],
    ["a whitespace-only name", { name: "  " }],
    ["a name over 150 characters", { name: "n".repeat(151) }],
    ["a description over 500 characters", { description: "d".repeat(501) }],
  ])("rejects %s", (_label, body) => {
    expect(updateFormSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    "organizationId",
    "createdBy",
    "_id",
    "createdAt",
    "updatedAt",
  ])("rejects protected field %s", (field) => {
    expect(
      updateFormSchema.safeParse({ name: "x", [field]: objectId() })
        .success,
    ).toBe(false);
    expect(
      updateFormSchema.safeParse({ [field]: objectId() }).success,
    ).toBe(false);
  });

  it.each(["randomField", "prototype", "constructor", "$where", "$set"])(
    "rejects unknown field %s",
    (field) => {
      expect(
        updateFormSchema.safeParse({ name: "x", [field]: "x" }).success,
      ).toBe(false);
    },
  );

  it("rejects $set, $where, __proto__ and constructor payloads", () => {
    for (const text of [
      '{"$set":{"organizationId":"x"}}',
      '{"$where":"1==1"}',
      '{"__proto__":{"admin":true}}',
      '{"name":"x","__proto__":{"admin":true}}',
      '{"constructor":{"prototype":{"admin":true}}}',
    ]) {
      expect(updateFormSchema.safeParse(json(text)).success, text).toBe(
        false,
      );
    }

    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it.each([
    ["name", { $ne: "" }],
    ["description", { $gt: "" }],
    ["slug", { $ne: null }],
    ["status", { $gt: "" }],
    ["projectId", { $ne: null }],
  ])("rejects an operator object for %s", (field, value) => {
    expect(updateFormSchema.safeParse({ [field]: value }).success).toBe(
      false,
    );
  });
});
