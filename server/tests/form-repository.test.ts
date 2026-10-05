import mongoose from "mongoose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Form } from "../src/models/form.model.js";
import {
  DEFAULT_FORM_LIST_LIMIT,
  MAX_FORM_LIST_LIMIT,
  createForm,
  deleteFormByIdAndOrganization,
  findFormByIdAndOrganization,
  findFormBySlugAndOrganization,
  findFormsByOrganization,
  updateFormByIdAndOrganization,
  type CreateFormData,
  type UpdateFormData,
} from "../src/repositories/form.repository.js";

/*
 * 8.17.3 — Form repository tests (real MongoDB test database).
 */

type Id = mongoose.Types.ObjectId;

const newId = (): Id => new mongoose.Types.ObjectId();

const formData = (
  overrides: Partial<CreateFormData> = {},
): CreateFormData => ({
  projectId: newId(),
  name: "Contact Form",
  description: "Collects contact details",
  slug: "contact-form",
  status: "DRAFT",
  createdBy: newId(),
  ...overrides,
});

// Simulates a buggy or malicious caller bypassing the TypeScript types.
const untyped = <T>(value: unknown): T => value as T;

beforeAll(async () => {
  await Form.init();
});

describe("createForm", () => {
  it("creates a form with the supplied trusted values", async () => {
    const organizationId = newId();
    const data = formData();

    const form = await createForm(organizationId, data);

    expect(form.organizationId.toString()).toBe(organizationId.toString());
    expect(form.projectId.toString()).toBe(data.projectId.toString());
    expect(form.createdBy.toString()).toBe(data.createdBy.toString());
    expect(form).toMatchObject({
      name: "Contact Form",
      description: "Collects contact details",
      slug: "contact-form",
      status: "DRAFT",
    });
    expect(form.createdAt).toBeInstanceOf(Date);
    expect(form.updatedAt).toBeInstanceOf(Date);

    const stored = await Form.findById(form._id).lean();
    expect(stored?.organizationId.toString()).toBe(organizationId.toString());
  });

  it("does not persist protected or arbitrary fields", async () => {
    const organizationId = newId();
    const otherOrganizationId = newId();
    const forgedId = newId();
    const forgedDate = new Date("2000-01-01T00:00:00.000Z");

    const form = await createForm(
      organizationId,
      untyped<CreateFormData>({
        ...formData(),
        _id: forgedId,
        organizationId: otherOrganizationId,
        createdAt: forgedDate,
        updatedAt: forgedDate,
        updatedBy: newId(),
        currentDraftVersionId: newId(),
        extra: "x",
        $where: "1==1",
      }),
    );

    expect(form._id.toString()).not.toBe(forgedId.toString());
    expect(form.organizationId.toString()).toBe(organizationId.toString());
    expect(form.createdAt.getTime()).not.toBe(forgedDate.getTime());
    expect(form.updatedAt.getTime()).not.toBe(forgedDate.getTime());

    const stored = await Form.findById(form._id).lean();
    expect(stored).not.toHaveProperty("extra");
    expect(stored).not.toHaveProperty("$where");
    expect(stored?.updatedBy).toBeUndefined();
    expect(stored?.currentDraftVersionId).toBeUndefined();
    expect(await Form.countDocuments({ _id: forgedId })).toBe(0);
  });

  it("rejects a non-ObjectId organizationId", async () => {
    await expect(
      createForm(untyped<Id>({ $ne: null }), formData()),
    ).rejects.toThrow(TypeError);
  });
});

describe("findFormByIdAndOrganization", () => {
  it("returns the tenant-owned form", async () => {
    const organizationId = newId();
    const created = await createForm(organizationId, formData());

    const found = await findFormByIdAndOrganization(
      created._id,
      organizationId,
    );

    expect(found?._id.toString()).toBe(created._id.toString());
  });

  it("returns null for a missing form", async () => {
    expect(
      await findFormByIdAndOrganization(newId(), newId()),
    ).toBeNull();
  });

  it("returns null for a cross-tenant lookup", async () => {
    const created = await createForm(newId(), formData());

    expect(
      await findFormByIdAndOrganization(created._id, newId()),
    ).toBeNull();
  });

  it("does not treat an operator object as an id or organization", async () => {
    const organizationId = newId();
    const created = await createForm(organizationId, formData());

    await expect(
      findFormByIdAndOrganization(
        untyped<Id>({ $ne: null }),
        organizationId,
      ),
    ).rejects.toThrow(TypeError);
    await expect(
      findFormByIdAndOrganization(
        created._id,
        untyped<Id>({ $ne: organizationId }),
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe("findFormBySlugAndOrganization", () => {
  it("returns the tenant-owned form by slug", async () => {
    const organizationId = newId();
    const created = await createForm(organizationId, formData());

    const found = await findFormBySlugAndOrganization(
      "contact-form",
      organizationId,
    );

    expect(found?._id.toString()).toBe(created._id.toString());
  });

  it("returns null for a cross-tenant slug lookup", async () => {
    await createForm(newId(), formData());

    expect(
      await findFormBySlugAndOrganization("contact-form", newId()),
    ).toBeNull();
  });

  it("returns the right form when two organizations share a slug", async () => {
    const orgA = newId();
    const orgB = newId();
    const a = await createForm(orgA, formData());
    const b = await createForm(orgB, formData());

    const foundA = await findFormBySlugAndOrganization("contact-form", orgA);
    const foundB = await findFormBySlugAndOrganization("contact-form", orgB);

    expect(foundA?._id.toString()).toBe(a._id.toString());
    expect(foundB?._id.toString()).toBe(b._id.toString());
  });

  it("does not treat an operator object as a slug", async () => {
    const organizationId = newId();
    await createForm(organizationId, formData());

    await expect(
      findFormBySlugAndOrganization(
        untyped<string>({ $ne: "" }),
        organizationId,
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe("findFormsByOrganization", () => {
  it("lists only the organization's forms, newest first", async () => {
    const orgA = newId();
    const orgB = newId();
    await createForm(orgA, formData({ slug: "a-one" }));
    await createForm(orgA, formData({ slug: "a-two" }));
    await createForm(orgB, formData({ slug: "b-one" }));

    const forms = await findFormsByOrganization(orgA);

    expect(forms.map((f) => f.slug)).toEqual(["a-two", "a-one"]);
    for (const form of forms) {
      expect(form.organizationId.toString()).toBe(orgA.toString());
    }
  });

  it("filters by projectId and stays tenant scoped", async () => {
    const orgA = newId();
    const orgB = newId();
    const projectId = newId();

    await createForm(orgA, formData({ slug: "in-project", projectId }));
    await createForm(orgA, formData({ slug: "other-project" }));
    // Same projectId id value, different organization.
    await createForm(orgB, formData({ slug: "foreign", projectId }));

    const forms = await findFormsByOrganization(orgA, { projectId });

    expect(forms.map((f) => f.slug)).toEqual(["in-project"]);
  });

  it("does not treat an operator object as projectId", async () => {
    const organizationId = newId();
    await createForm(organizationId, formData());

    await expect(
      findFormsByOrganization(organizationId, {
        projectId: untyped<Id>({ $ne: newId() }),
      }),
    ).rejects.toThrow(TypeError);
  });

  describe("pagination", () => {
    const organizationId = newId();

    // tests/setup.ts empties every collection before each test, so the
    // data has to be seeded per test.
    beforeEach(async () => {
      for (const slug of ["p1", "p2", "p3", "p4", "p5"]) {
        await createForm(organizationId, formData({ slug }));
      }
    });

    const slugs = (forms: { slug: string }[]): string[] =>
      forms.map((f) => f.slug);

    it("applies limit and skip", async () => {
      expect(
        slugs(await findFormsByOrganization(organizationId, { limit: 2 })),
      ).toEqual(["p5", "p4"]);
      expect(
        slugs(await findFormsByOrganization(organizationId, { skip: 3 })),
      ).toEqual(["p2", "p1"]);
      expect(
        slugs(
          await findFormsByOrganization(organizationId, {
            limit: 2,
            skip: 1,
          }),
        ),
      ).toEqual(["p4", "p3"]);
    });

    it("clamps a too-small limit to 1 and a negative skip to 0", async () => {
      expect(
        slugs(
          await findFormsByOrganization(organizationId, {
            limit: 0,
            skip: -5,
          }),
        ),
      ).toEqual(["p5"]);
    });
  });

  it("uses the default limit of 20", async () => {
    const organizationId = newId();
    await Form.insertMany(
      Array.from({ length: DEFAULT_FORM_LIST_LIMIT + 5 }, (_, i) => ({
        ...formData({ slug: `bulk-${i}` }),
        organizationId,
      })),
    );

    expect(await findFormsByOrganization(organizationId)).toHaveLength(
      DEFAULT_FORM_LIST_LIMIT,
    );
  });

  it("never returns more than the maximum limit of 100", async () => {
    const organizationId = newId();
    await Form.insertMany(
      Array.from({ length: MAX_FORM_LIST_LIMIT + 5 }, (_, i) => ({
        ...formData({ slug: `bulk-${i}` }),
        organizationId,
      })),
    );

    expect(MAX_FORM_LIST_LIMIT).toBe(100);
    expect(
      await findFormsByOrganization(organizationId, { limit: 1000 }),
    ).toHaveLength(MAX_FORM_LIST_LIMIT);
  });
});

describe("updateFormByIdAndOrganization", () => {
  const setup = async () => {
    const organizationId = newId();
    const form = await createForm(organizationId, formData());
    return { organizationId, form };
  };

  it("updates name, description, slug and status and returns the new document", async () => {
    const { organizationId, form } = await setup();

    const updated = await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      {
        name: "Renamed",
        description: "New description",
        slug: "renamed",
        status: "PUBLISHED",
      },
    );

    expect(updated).toMatchObject({
      name: "Renamed",
      description: "New description",
      slug: "renamed",
      status: "PUBLISHED",
    });
    expect(updated?._id.toString()).toBe(form._id.toString());

    const stored = await Form.findById(form._id).lean();
    expect(stored).toMatchObject({
      name: "Renamed",
      description: "New description",
      slug: "renamed",
      status: "PUBLISHED",
    });
  });

  it("changes only the supplied field", async () => {
    const { organizationId, form } = await setup();

    const updated = await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      { name: "Only Name" },
    );

    expect(updated?.name).toBe("Only Name");
    expect(updated?.slug).toBe(form.slug);
    expect(updated?.status).toBe(form.status);
    expect(updated?.description).toBe(form.description);
  });

  it("updates projectId, currentDraftVersionId, publishedVersionId and updatedBy", async () => {
    const { organizationId, form } = await setup();
    const projectId = newId();
    const currentDraftVersionId = newId();
    const publishedVersionId = newId();
    const updatedBy = newId();

    const updated = await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      { projectId, currentDraftVersionId, publishedVersionId, updatedBy },
    );

    expect(updated?.projectId.toString()).toBe(projectId.toString());
    expect(updated?.currentDraftVersionId?.toString()).toBe(
      currentDraftVersionId.toString(),
    );
    expect(updated?.publishedVersionId?.toString()).toBe(
      publishedVersionId.toString(),
    );
    expect(updated?.updatedBy?.toString()).toBe(updatedBy.toString());
  });

  it("advances updatedAt and keeps createdAt", async () => {
    const { organizationId, form } = await setup();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const updated = await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      { name: "Later" },
    );

    expect(updated?.createdAt.getTime()).toBe(form.createdAt.getTime());
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      form.updatedAt.getTime(),
    );
  });

  it("cannot change protected fields", async () => {
    const { organizationId, form } = await setup();
    const forgedDate = new Date("2000-01-01T00:00:00.000Z");
    const otherOrganizationId = newId();
    const forgedId = newId();
    const forgedCreator = newId();

    const updated = await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      untyped<UpdateFormData>({
        name: "Changed",
        _id: forgedId,
        organizationId: otherOrganizationId,
        createdBy: forgedCreator,
        createdAt: forgedDate,
        updatedAt: forgedDate,
      }),
    );

    expect(updated?.name).toBe("Changed");
    expect(updated?._id.toString()).toBe(form._id.toString());
    expect(updated?.organizationId.toString()).toBe(
      organizationId.toString(),
    );
    expect(updated?.createdBy.toString()).toBe(form.createdBy.toString());
    expect(updated?.createdAt.getTime()).toBe(form.createdAt.getTime());
    expect(updated?.updatedAt.getTime()).not.toBe(forgedDate.getTime());
    expect(await Form.countDocuments({ _id: forgedId })).toBe(0);
  });

  it("does not persist unknown fields", async () => {
    const { organizationId, form } = await setup();

    await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      untyped<UpdateFormData>({ name: "Known", randomField: "x" }),
    );

    const stored = await Form.findById(form._id).lean();
    expect(stored?.name).toBe("Known");
    expect(stored).not.toHaveProperty("randomField");
  });

  it("does not execute operator-style payloads", async () => {
    const { organizationId, form } = await setup();
    const otherOrganizationId = newId();

    // Top-level operator keys are dropped by the allowlist.
    const updated = await updateFormByIdAndOrganization(
      form._id,
      organizationId,
      untyped<UpdateFormData>({
        name: "Safe",
        $set: { organizationId: otherOrganizationId },
        $unset: { slug: "" },
        $where: "1==1",
        $or: [{ name: "x" }],
      }),
    );

    expect(updated?.name).toBe("Safe");
    expect(updated?.organizationId.toString()).toBe(
      organizationId.toString(),
    );
    expect(updated?.slug).toBe(form.slug);

    // Operator objects as field values are rejected, never executed.
    await expect(
      updateFormByIdAndOrganization(
        form._id,
        organizationId,
        untyped<UpdateFormData>({ name: { $ne: "" } }),
      ),
    ).rejects.toThrow();
    await expect(
      updateFormByIdAndOrganization(
        form._id,
        organizationId,
        untyped<UpdateFormData>({ status: { $gt: "" } }),
      ),
    ).rejects.toThrow();
    await expect(
      updateFormByIdAndOrganization(
        form._id,
        organizationId,
        untyped<UpdateFormData>({ projectId: { $ne: null } }),
      ),
    ).rejects.toThrow(TypeError);

    const stored = await Form.findById(form._id).lean();
    expect(stored?.name).toBe("Safe");
    expect(stored?.status).toBe("DRAFT");
    expect(stored?.organizationId.toString()).toBe(
      organizationId.toString(),
    );
  });

  it("rejects an invalid status through schema validation", async () => {
    const { organizationId, form } = await setup();

    await expect(
      updateFormByIdAndOrganization(form._id, organizationId, {
        status: untyped<UpdateFormData["status"]>("ACTIVE"),
      }),
    ).rejects.toThrow();

    expect((await Form.findById(form._id).lean())?.status).toBe("DRAFT");
  });

  it("returns null and changes nothing for a cross-tenant update", async () => {
    const { form } = await setup();

    const result = await updateFormByIdAndOrganization(form._id, newId(), {
      name: "Hijacked",
      status: "ARCHIVED",
    });

    expect(result).toBeNull();

    const stored = await Form.findById(form._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.status).toBe("DRAFT");
  });

  it("returns null for a missing form", async () => {
    expect(
      await updateFormByIdAndOrganization(newId(), newId(), { name: "x" }),
    ).toBeNull();
  });
});

describe("deleteFormByIdAndOrganization", () => {
  it("deletes a tenant-owned form", async () => {
    const organizationId = newId();
    const form = await createForm(organizationId, formData());

    expect(
      await deleteFormByIdAndOrganization(form._id, organizationId),
    ).toBe(true);
    expect(await Form.countDocuments({ _id: form._id })).toBe(0);
  });

  it("returns false and deletes nothing for a cross-tenant delete", async () => {
    const form = await createForm(newId(), formData());

    expect(await deleteFormByIdAndOrganization(form._id, newId())).toBe(
      false,
    );
    expect(await Form.countDocuments({ _id: form._id })).toBe(1);
  });

  it("returns false for a missing form", async () => {
    expect(await deleteFormByIdAndOrganization(newId(), newId())).toBe(
      false,
    );
  });

  it("does not treat an operator object as an id", async () => {
    const organizationId = newId();
    await createForm(organizationId, formData());

    await expect(
      deleteFormByIdAndOrganization(
        untyped<Id>({ $ne: null }),
        organizationId,
      ),
    ).rejects.toThrow(TypeError);
    expect(await Form.countDocuments({ organizationId })).toBe(1);
  });
});

describe("slug uniqueness", () => {
  it("allows the same slug in different organizations", async () => {
    await createForm(newId(), formData());

    await expect(
      createForm(newId(), formData()),
    ).resolves.toBeDefined();
    expect(await Form.countDocuments({ slug: "contact-form" })).toBe(2);
  });

  it("bubbles up a duplicate-key error for the same organization", async () => {
    const organizationId = newId();
    await createForm(organizationId, formData());

    await expect(
      createForm(organizationId, formData({ projectId: newId() })),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await Form.countDocuments({ organizationId })).toBe(1);
  });

  it("bubbles up a duplicate-key error when an update collides", async () => {
    const organizationId = newId();
    await createForm(organizationId, formData({ slug: "taken" }));
    const other = await createForm(
      organizationId,
      formData({ slug: "other" }),
    );

    await expect(
      updateFormByIdAndOrganization(other._id, organizationId, {
        slug: "taken",
      }),
    ).rejects.toMatchObject({ code: 11000 });
    expect((await Form.findById(other._id).lean())?.slug).toBe("other");
  });
});
