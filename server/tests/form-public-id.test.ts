import mongoose from "mongoose";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import app from "../src/app.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { assignPublicIdIfMissing } from "../src/repositories/form.repository.js";
import {
  PUBLIC_ID_LENGTH,
  generatePublicId,
  isValidPublicId,
} from "../src/utils/public-id.util.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  objectId,
  type TestSession,
  type TestUser,
} from "./helpers.js";
import { expectStandardError, type ErrorBody } from "./security-helpers.js";

/*
 * SERVER-1 — Form.publicId: generated server-side when a form is first
 * published, immutable afterwards, unique, and never client-writable.
 */

interface Tenant {
  user: TestUser;
  session: TestSession;
  projectId: string;
}

const createTenant = async (): Promise<Tenant> => {
  const user = await createTestUser();
  const role = await Role.create({
    organizationId: user.organizationId,
    name: ROLE_NAMES.OWNER,
    description: "",
    permissions: [...OWNER_PERMISSIONS],
  });
  await User.updateOne({ _id: user.userId }, { $set: { roleIds: [role._id] } });
  const project = await Project.create({
    organizationId: user.organizationId,
    createdBy: user.userId,
    name: "Project",
    slug: `project-${objectId()}`,
    status: "ACTIVE",
  });

  return {
    user,
    session: await createTestSession(user),
    projectId: project._id.toString(),
  };
};

const auth = (tenant: Tenant): string => bearer(tenant.session.accessToken);

const textField = (id: string) => ({
  id,
  type: "TEXT",
  label: "Name",
  description: "",
  required: false,
  config: { placeholder: "", defaultValue: "" },
  validation: {},
  conditionalLogic: null,
});

const draftOf = (...ids: string[]) => ({
  version: 1,
  fields: ids.map(textField),
});

let counter = 0;

const createFormViaApi = async (tenant: Tenant): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact Form",
      slug: `contact-form-${counter}`,
      status: "draft",
      projectId: tenant.projectId,
    });
  expect(res.status).toBe(201);
  return res.body.data.form._id as string;
};

const saveDraft = (tenant: Tenant, formId: string, draft: unknown) =>
  request(app)
    .patch(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant))
    .send({ draftSchema: draft });

const publish = (tenant: Tenant, formId: string) =>
  request(app)
    .post(`/api/forms/${formId}/publish`)
    .set("Authorization", auth(tenant));

const getForm = (tenant: Tenant, formId: string) =>
  request(app)
    .get(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant));

const publishedForm = async () => {
  const tenant = await createTenant();
  const formId = await createFormViaApi(tenant);
  expect((await saveDraft(tenant, formId, draftOf("a"))).status).toBe(200);
  expect((await publish(tenant, formId)).status).toBe(200);
  return { tenant, formId };
};

beforeAll(async () => {
  await Form.init();
});

describe("generatePublicId", () => {
  it("is 24 URL-safe characters", () => {
    const id = generatePublicId();

    expect(id).toHaveLength(PUBLIC_ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(isValidPublicId(id)).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, generatePublicId));

    expect(ids.size).toBe(2000);
  });

  it("is not sequential or time/ObjectId shaped", () => {
    const ids = Array.from({ length: 50 }, generatePublicId);
    const prefixes = new Set(ids.map((id) => id.slice(0, 4)));

    // Random data: practically every prefix differs.
    expect(prefixes.size).toBeGreaterThan(45);
    for (const id of ids) {
      expect(mongoose.isValidObjectId(id)).toBe(false);
    }
  });

  it.each([
    "",
    "short",
    "a".repeat(23),
    "a".repeat(25),
    `${"a".repeat(23)}/`,
    `${"a".repeat(23)} `,
    `${"a".repeat(23)}$`,
    "$where".padEnd(24, "a"),
    "../../etc/passwd/xxxxxxx",
  ])("isValidPublicId rejects %j", (value) => {
    expect(isValidPublicId(value)).toBe(false);
  });

  it.each([null, undefined, 5, {}, ["a".repeat(24)], { $ne: "x" }])(
    "isValidPublicId rejects non-string %j",
    (value) => {
      expect(isValidPublicId(value)).toBe(false);
    },
  );
});

describe("Form.publicId model", () => {
  const base = async () => {
    const tenant = await createTenant();
    return {
      organizationId: tenant.user.organizationId,
      projectId: tenant.projectId,
      createdBy: tenant.user.userId,
      status: "DRAFT",
    };
  };

  it("has a unique sparse index", async () => {
    const indexes = await Form.collection.indexes();
    const index = indexes.find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ publicId: 1 }),
    );

    expect(index?.unique).toBe(true);
    expect(index?.sparse).toBe(true);
  });

  it("allows many forms without a publicId", async () => {
    const data = await base();

    await Form.create({ ...data, name: "A", slug: "a" });
    await expect(
      Form.create({ ...data, name: "B", slug: "b" }),
    ).resolves.toBeDefined();
  });

  it("rejects a duplicate publicId, even across organizations", async () => {
    const publicId = generatePublicId();
    await Form.create({ ...(await base()), name: "A", slug: "a", publicId });

    await expect(
      Form.create({ ...(await base()), name: "B", slug: "b", publicId }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it.each(["short", "a".repeat(25), "has space has space has s", "a".repeat(23) + "$"])(
    "rejects a malformed publicId %j",
    async (publicId) => {
      await expect(
        Form.create({ ...(await base()), name: "A", slug: "a", publicId }),
      ).rejects.toThrow(/validation failed/i);
    },
  );
});

describe("assignment on first publish", () => {
  it("a draft form has no publicId, a published one does", async () => {
    const tenant = await createTenant();
    const formId = await createFormViaApi(tenant);

    const before = await getForm(tenant, formId);
    expect(before.body.data.form.publicId).toBeUndefined();
    expect((await Form.findById(formId).lean())?.publicId).toBeUndefined();

    await saveDraft(tenant, formId, draftOf("a"));
    expect((await Form.findById(formId).lean())?.publicId).toBeUndefined();

    await publish(tenant, formId);

    const stored = await Form.findById(formId).lean();
    expect(stored?.publicId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await getForm(tenant, formId)).body.data.form.publicId).toBe(
      stored?.publicId,
    );
  });

  it("is unrelated to the form, organization, user or slug", async () => {
    const { tenant, formId } = await publishedForm();
    const stored = await Form.findById(formId).lean();
    const publicId = stored?.publicId ?? "";

    for (const secret of [
      formId,
      tenant.user.organizationId,
      tenant.user.userId,
      tenant.projectId,
      stored?.slug ?? "",
    ]) {
      expect(publicId).not.toContain(secret);
    }
    expect(mongoose.isValidObjectId(publicId)).toBe(false);
  });

  it("keeps the same publicId when the form is published again", async () => {
    const { tenant, formId } = await publishedForm();
    const first = (await Form.findById(formId).lean())?.publicId;

    await saveDraft(tenant, formId, draftOf("a", "b"));
    expect((await publish(tenant, formId)).body.data.version).toBe(2);
    await saveDraft(tenant, formId, draftOf("a", "b", "c"));
    expect((await publish(tenant, formId)).body.data.version).toBe(3);

    expect((await Form.findById(formId).lean())?.publicId).toBe(first);
  });

  it("gives every form its own publicId", async () => {
    const a = await publishedForm();
    const b = await publishedForm();

    const idA = (await Form.findById(a.formId).lean())?.publicId;
    const idB = (await Form.findById(b.formId).lean())?.publicId;

    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
  });

  it("still updates status, version pointer and updatedAt in the same step", async () => {
    const tenant = await createTenant();
    const formId = await createFormViaApi(tenant);
    await saveDraft(tenant, formId, draftOf("a"));
    const before = await Form.findById(formId).lean();

    const res = await publish(tenant, formId);

    const after = await Form.findById(formId).lean();
    expect(after?.status).toBe("PUBLISHED");
    expect(after?.publishedVersionId?.toString()).toBe(res.body.data.versionId);
    expect(after?.updatedBy?.toString()).toBe(tenant.user.userId);
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before?.updatedAt.getTime() ?? 0,
    );
    expect(after?.draftSchema).toEqual(draftOf("a"));
  });

  it("does not change on draft saves or metadata updates", async () => {
    const { tenant, formId } = await publishedForm();
    const first = (await Form.findById(formId).lean())?.publicId;

    await saveDraft(tenant, formId, draftOf("a", "b"));
    await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(tenant))
      .send({ name: "Renamed", status: "archived" });

    expect((await Form.findById(formId).lean())?.publicId).toBe(first);
  });

  it("survives concurrent publishes: at most one version and one stable id", async () => {
    const tenant = await createTenant();
    const formId = await createFormViaApi(tenant);
    await saveDraft(tenant, formId, draftOf("a"));

    await Promise.all(Array.from({ length: 5 }, () => publish(tenant, formId)));

    const stored = await Form.findById(formId).lean();
    expect(stored?.publicId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const again = (await Form.findById(formId).lean())?.publicId;
    expect(again).toBe(stored?.publicId);
  });
});

describe("a client can never set publicId", () => {
  it("POST /api/forms rejects it", async () => {
    const tenant = await createTenant();

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", auth(tenant))
      .send({
        name: "X",
        slug: "x",
        status: "draft",
        projectId: tenant.projectId,
        publicId: generatePublicId(),
      });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("PATCH /api/forms/:id rejects it, before and after publishing", async () => {
    const draftOnly = await createTenant();
    const draftId = await createFormViaApi(draftOnly);
    const { tenant, formId } = await publishedForm();
    const original = (await Form.findById(formId).lean())?.publicId;
    const forged = generatePublicId();

    for (const [t, id] of [
      [draftOnly, draftId],
      [tenant, formId],
    ] as const) {
      const res = await request(app)
        .patch(`/api/forms/${id}`)
        .set("Authorization", auth(t))
        .send({ publicId: forged });

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect((await Form.findById(draftId).lean())?.publicId).toBeUndefined();
    expect((await Form.findById(formId).lean())?.publicId).toBe(original);
  });

  it("is rejected alongside a draft save too", async () => {
    const { tenant, formId } = await publishedForm();
    const original = (await Form.findById(formId).lean())?.publicId;

    const res = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(tenant))
      .send({ draftSchema: draftOf("a"), publicId: generatePublicId() });

    expect(res.status).toBe(400);
    expect((await Form.findById(formId).lean())?.publicId).toBe(original);
  });
});

describe("published forms that predate publicId", () => {
  const legacyForm = async (tenant: Tenant, slug = "legacy") => {
    const versionId = new mongoose.Types.ObjectId();
    const form = await Form.create({
      organizationId: tenant.user.organizationId,
      projectId: tenant.projectId,
      createdBy: tenant.user.userId,
      name: "Legacy",
      slug,
      status: "PUBLISHED",
      publishedVersionId: versionId,
    });
    expect(form.publicId).toBeUndefined();
    return form._id.toString();
  };

  it("gets one the first time the owner reads the form, and keeps it", async () => {
    const tenant = await createTenant();
    const id = await legacyForm(tenant);

    const first = await getForm(tenant, id);
    const second = await getForm(tenant, id);

    expect(first.body.data.form.publicId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(second.body.data.form.publicId).toBe(first.body.data.form.publicId);
    expect((await Form.findById(id).lean())?.publicId).toBe(
      first.body.data.form.publicId,
    );
  });

  it("is also assigned when read by slug", async () => {
    const tenant = await createTenant();
    await legacyForm(tenant, "legacy-slug");

    const res = await request(app)
      .get("/api/forms/slug/legacy-slug")
      .set("Authorization", auth(tenant));

    expect(res.body.data.form.publicId).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it("is not assigned to an unpublished form, or by another tenant's read", async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    const draftId = await createFormViaApi(tenant);
    const legacyId = await legacyForm(tenant);

    await getForm(tenant, draftId);
    const foreign = await getForm(other, legacyId);

    expect((await Form.findById(draftId).lean())?.publicId).toBeUndefined();
    expect(foreign.status).toBe(404);
    expect((await Form.findById(legacyId).lean())?.publicId).toBeUndefined();
  });

  it("assignPublicIdIfMissing is race-safe: concurrent callers agree on one value", async () => {
    const tenant = await createTenant();
    const id = new mongoose.Types.ObjectId(await legacyForm(tenant));
    const organizationId = new mongoose.Types.ObjectId(tenant.user.organizationId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        assignPublicIdIfMissing(id, organizationId, generatePublicId()),
      ),
    );

    const values = new Set(results.map((form) => form?.publicId));
    expect(values.size).toBe(1);
    expect([...values][0]).toBe((await Form.findById(id).lean())?.publicId);
  });

  it("assignPublicIdIfMissing never overwrites an existing value or crosses tenants", async () => {
    const tenant = await createTenant();
    const other = await createTenant();
    const id = new mongoose.Types.ObjectId(await legacyForm(tenant));
    const org = new mongoose.Types.ObjectId(tenant.user.organizationId);
    const otherOrg = new mongoose.Types.ObjectId(other.user.organizationId);

    const first = await assignPublicIdIfMissing(id, org, generatePublicId());
    const second = await assignPublicIdIfMissing(id, org, generatePublicId());
    const foreign = await assignPublicIdIfMissing(id, otherOrg, generatePublicId());

    expect(second?.publicId).toBe(first?.publicId);
    expect(foreign).toBeNull();
    expect((await Form.findById(id).lean())?.publicId).toBe(first?.publicId);
  });

  it("rejects a malformed publicId at the repository", async () => {
    const tenant = await createTenant();
    const id = new mongoose.Types.ObjectId(await legacyForm(tenant));
    const org = new mongoose.Types.ObjectId(tenant.user.organizationId);

    await expect(
      assignPublicIdIfMissing(id, org, { $ne: "x" } as unknown as string),
    ).rejects.toThrow(TypeError);
    await expect(assignPublicIdIfMissing(id, org, "short")).rejects.toThrow();
    expect((await Form.findById(id).lean())?.publicId).toBeUndefined();
  });
});

describe("list responses", () => {
  it("include publicId for published forms and never the draft", async () => {
    const { tenant, formId } = await publishedForm();

    const res = await request(app)
      .get("/api/forms")
      .set("Authorization", auth(tenant));

    const form = (res.body.data.forms as Record<string, unknown>[]).find(
      (f) => f._id === formId,
    );
    expect(form?.publicId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(form).not.toHaveProperty("draftSchema");
  });
});
