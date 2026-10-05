import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";

import { Form } from "../src/models/form.model.js";

import { objectId } from "./helpers.js";

/*
 * 8.17.1 — Form model tests (real MongoDB test database).
 */

const validData = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  organizationId: objectId(),
  projectId: objectId(),
  name: "Contact Form",
  slug: "contact-form",
  status: "DRAFT",
  createdBy: objectId(),
  ...overrides,
});

const without = (field: string): Record<string, unknown> => {
  const data = validData();
  delete data[field];
  return data;
};

beforeAll(async () => {
  await Form.init();
});

describe("Form model", () => {
  it("creates a valid form", async () => {
    const form = await Form.create(validData());

    expect(form._id).toBeDefined();
    expect(await Form.countDocuments({ _id: form._id })).toBe(1);
  });

  it.each([
    "organizationId",
    "projectId",
    "name",
    "slug",
    "status",
    "createdBy",
  ])("requires %s", async (field) => {
    await expect(Form.create(without(field))).rejects.toThrow(
      /validation failed/i,
    );
  });

  it.each(["DRAFT", "PUBLISHED", "ARCHIVED"])(
    "accepts status %s",
    async (status) => {
      const form = await Form.create(validData({ status }));

      expect(form.status).toBe(status);
    },
  );

  it.each(["ACTIVE", "draft", "", "PUBLISHED "])(
    "rejects invalid status %j",
    async (status) => {
      await expect(
        Form.create(validData({ status })),
      ).rejects.toThrow(/validation failed/i);
    },
  );

  it("enforces name, description and slug maximum lengths", async () => {
    await expect(
      Form.create(validData({ name: "n".repeat(151) })),
    ).rejects.toThrow(/validation failed/i);
    await expect(
      Form.create(validData({ description: "d".repeat(501) })),
    ).rejects.toThrow(/validation failed/i);
    await expect(
      Form.create(validData({ slug: "s".repeat(151) })),
    ).rejects.toThrow(/validation failed/i);

    await expect(
      Form.create(
        validData({
          name: "n".repeat(150),
          description: "d".repeat(500),
          slug: "s".repeat(150),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("trims name and description and lowercases the slug", async () => {
    const form = await Form.create(
      validData({
        name: "  Padded  ",
        description: "  text  ",
        slug: "  Mixed-Case  ",
      }),
    );

    expect(form.name).toBe("Padded");
    expect(form.description).toBe("text");
    expect(form.slug).toBe("mixed-case");
  });

  it('defaults description to ""', async () => {
    const form = await Form.create(validData());

    expect(form.description).toBe("");
  });

  it("sets createdAt and updatedAt", async () => {
    const form = await Form.create(validData());

    expect(form.createdAt).toBeInstanceOf(Date);
    expect(form.updatedAt).toBeInstanceOf(Date);
  });

  it("stores organizationId, projectId and createdBy", async () => {
    const organizationId = objectId();
    const projectId = objectId();
    const createdBy = objectId();

    const form = await Form.create(
      validData({ organizationId, projectId, createdBy }),
    );
    const stored = await Form.findById(form._id).lean();

    expect(stored?.organizationId.toString()).toBe(organizationId);
    expect(stored?.projectId.toString()).toBe(projectId);
    expect(stored?.createdBy.toString()).toBe(createdBy);
  });

  it("supports updatedBy, currentDraftVersionId and publishedVersionId", async () => {
    const updatedBy = objectId();
    const currentDraftVersionId = objectId();
    const publishedVersionId = objectId();

    const form = await Form.create(
      validData({
        updatedBy,
        currentDraftVersionId,
        publishedVersionId,
      }),
    );
    const stored = await Form.findById(form._id).lean();

    expect(stored?.updatedBy?.toString()).toBe(updatedBy);
    expect(stored?.currentDraftVersionId?.toString()).toBe(
      currentDraftVersionId,
    );
    expect(stored?.publishedVersionId?.toString()).toBe(
      publishedVersionId,
    );
  });

  it("leaves the optional ObjectId fields unset by default", async () => {
    const form = await Form.create(validData());
    const stored = await Form.findById(form._id).lean();

    expect(stored?.updatedBy).toBeUndefined();
    expect(stored?.currentDraftVersionId).toBeUndefined();
    expect(stored?.publishedVersionId).toBeUndefined();
  });

  it("rejects a malformed ObjectId", async () => {
    await expect(
      Form.create(validData({ projectId: "not-an-id" })),
    ).rejects.toThrow(/validation failed/i);
  });
});

describe("Form indexes", () => {
  it("has a unique organizationId + slug index", async () => {
    const indexes = await Form.collection.indexes();
    const index = indexes.find(
      (i) =>
        JSON.stringify(i.key) ===
        JSON.stringify({ organizationId: 1, slug: 1 }),
    );

    expect(index).toBeDefined();
    expect(index?.unique).toBe(true);
  });

  it("has no globally unique slug index", async () => {
    const indexes = await Form.collection.indexes();

    expect(
      indexes.some(
        (i) => JSON.stringify(i.key) === JSON.stringify({ slug: 1 }),
      ),
    ).toBe(false);
  });

  it("has a non-unique organizationId + projectId index", async () => {
    const indexes = await Form.collection.indexes();
    const index = indexes.find(
      (i) =>
        JSON.stringify(i.key) ===
        JSON.stringify({ organizationId: 1, projectId: 1 }),
    );

    expect(index).toBeDefined();
    expect(index?.unique).toBeFalsy();
  });
});

describe("Form slug uniqueness", () => {
  it("allows the same slug in different organizations", async () => {
    await Form.create(validData({ slug: "shared" }));
    await Form.create(validData({ slug: "shared" }));

    expect(await Form.countDocuments({ slug: "shared" })).toBe(2);
  });

  it("rejects a duplicate slug within one organization", async () => {
    const organizationId = objectId();

    await Form.create(validData({ organizationId, slug: "dup" }));

    await expect(
      Form.create(
        validData({
          organizationId,
          projectId: objectId(),
          slug: "dup",
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });

    expect(
      await Form.countDocuments({
        organizationId: new mongoose.Types.ObjectId(organizationId),
        slug: "dup",
      }),
    ).toBe(1);
  });
});
