import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { publishedFormCacheKey } from "../src/repositories/published-form-cache.repository.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { FormVersion } from "../src/models/form-version.model.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";

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
 * GET /api/forms/:id/published — the immutable version shown by
 * "Test User". Never the draft; tenant scoped; FORM_READ only.
 */

interface Tenant {
  user: TestUser;
  session: TestSession;
  projectId: string;
}

const createTenant = async (
  permissions: readonly string[] = OWNER_PERMISSIONS,
): Promise<Tenant> => {
  const user = await createTestUser();
  const role = await Role.create({
    organizationId: user.organizationId,
    name: ROLE_NAMES.OWNER,
    description: "",
    permissions: [...permissions],
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

const draftWith = (label: string) => ({
  version: 1,
  fields: [
    {
      id: "name_field",
      type: "TEXT",
      label,
      description: "",
      required: false,
      config: { placeholder: "", defaultValue: "" },
      validation: {},
      conditionalLogic: null,
    },
  ],
});

let counter = 0;

const createForm = async (tenant: Tenant): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact Form",
      slug: `published-form-${counter}`,
      status: "draft",
      projectId: tenant.projectId,
    });
  expect(res.status).toBe(201);
  return res.body.data.form._id as string;
};

const save = (tenant: Tenant, formId: string, draft: unknown) =>
  request(app)
    .patch(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant))
    .send({ draftSchema: draft });

const publish = (tenant: Tenant, formId: string) =>
  request(app)
    .post(`/api/forms/${formId}/publish`)
    .set("Authorization", auth(tenant));

const getPublished = (tenant: Tenant, formId: string) =>
  request(app)
    .get(`/api/forms/${formId}/published`)
    .set("Authorization", auth(tenant));

describe("GET /api/forms/:id/published", () => {
  it("returns the immutable published version", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, draftWith("Published label"));
    const pub = await publish(tenant, formId);
    expect(pub.status).toBe(200);

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    const view = res.body.data.published;
    expect(view.formId).toBe(formId);
    expect(view.versionId).toBe(pub.body.data.versionId);
    expect(view.version).toBe(1);
    expect(view.schema).toEqual(draftWith("Published label"));
    // Whitelisted fields only.
    expect(Object.keys(view).sort()).toEqual(
      ["formId", "name", "publishedAt", "schema", "version", "versionId"].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain(tenant.user.organizationId);
  });

  it("keeps showing the published version while the draft is edited", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, draftWith("Published label"));
    await publish(tenant, formId);
    await save(tenant, formId, draftWith("Secret unpublished edit"));

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.data.published.schema).toEqual(
      draftWith("Published label"),
    );
    expect(JSON.stringify(res.body)).not.toContain("Secret unpublished edit");
  });

  it("serves the latest version after a republish, and does not change versions", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, draftWith("One"));
    await publish(tenant, formId);
    await save(tenant, formId, draftWith("Two"));
    await publish(tenant, formId);

    const res = await getPublished(tenant, formId);

    expect(res.body.data.published.version).toBe(2);
    expect(res.body.data.published.schema).toEqual(draftWith("Two"));
    expect(await FormVersion.countDocuments({ formId })).toBe(2);
  });

  it("does not expose an unpublished form's draft", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, draftWith("Never published"));

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_PUBLISHED");
    expect(JSON.stringify(res.body)).not.toContain("Never published");
    expect(await FormVersion.countDocuments({})).toBe(0);
    expect((await Form.findById(formId))?.status).toBe("DRAFT");
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`/api/forms/${objectId()}/published`);

    expect(res.status).toBe(401);
  });

  it("requires form.read", async () => {
    const tenant = await createTenant(
      OWNER_PERMISSIONS.filter((p) => p !== PERMISSIONS.FORM_READ),
    );

    const res = await getPublished(tenant, objectId());

    expect(res.status).toBe(403);
    expectStandardError(res.body as ErrorBody, "FORBIDDEN");
  });

  it("cannot read another organization's published form", async () => {
    const a = await createTenant();
    const formId = await createForm(a);
    await save(a, formId, draftWith("A's form"));
    await publish(a, formId);
    const b = await createTenant();

    const res = await getPublished(b, formId);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toContain("A's form");
  });

  it("rejects a malformed id with 400", async () => {
    const tenant = await createTenant();

    const res = await getPublished(tenant, "not-an-id");

    expect(res.status).toBe(400);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const published = async () => {
  const tenant = await createTenant();
  const formId = await createForm(tenant);
  await save(tenant, formId, draftWith("Published label"));
  const pub = await publish(tenant, formId);
  expect(pub.status).toBe(200);
  return { tenant, formId };
};

const cacheKey = (tenant: Tenant, formId: string) =>
  publishedFormCacheKey(tenant.user.organizationId, formId);

describe("published form: response contract", () => {
  it("never returns draftSchema or private fields", async () => {
    const { tenant, formId } = await published();
    await save(tenant, formId, draftWith("Draft only"));

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.message).toBe("string");
    const text = JSON.stringify(res.body);
    for (const forbidden of [
      "draftSchema",
      "Draft only",
      "organizationId",
      "createdBy",
      "publishedBy",
      "updatedBy",
      "currentDraftVersionId",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("returns a standard error body for a missing form", async () => {
    const tenant = await createTenant();

    const res = await getPublished(tenant, objectId());

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*.ts/);
  });

  it("does not serve an archived form, and sees the archive at once", async () => {
    const { tenant, formId } = await published();
    expect((await getPublished(tenant, formId)).status).toBe(200);

    const archived = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(tenant))
      .send({ status: "ARCHIVED" });
    expect(archived.status).toBe(200);

    const res = await getPublished(tenant, formId);
    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_PUBLISHED");
  });

  it("keeps a published version unchanged when the draft is republished", async () => {
    const { tenant, formId } = await published();
    const first = await FormVersion.findOne({ formId, version: 1 }).lean();
    await save(tenant, formId, draftWith("Changed"));
    await publish(tenant, formId);

    const again = await FormVersion.findOne({ formId, version: 1 }).lean();
    expect(again?.schemaSnapshot).toEqual(first?.schemaSnapshot);
    expect(again?.schemaSnapshot).toEqual(draftWith("Published label"));
  });
});

describe("published form: Redis cache", () => {
  it("reads MongoDB on a miss and stores it under the tenant-and-form key", async () => {
    const { tenant, formId } = await published();
    expect(await redisClient.get(cacheKey(tenant, formId))).toBeNull();

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    const cached = JSON.parse((await redisClient.get(cacheKey(tenant, formId)))!);
    expect(cached).toEqual(res.body.data.published);
    expect(await redisClient.ttl(cacheKey(tenant, formId))).toBeGreaterThan(0);
  });

  it("serves a cache hit without reading MongoDB", async () => {
    const { tenant, formId } = await published();
    await getPublished(tenant, formId);
    const spy = vi.spyOn(Form, "findOne");

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(res.body.data.published.schema).toEqual(draftWith("Published label"));
  });

  it("ignores a malformed cache entry and rebuilds it from MongoDB", async () => {
    const { tenant, formId } = await published();
    await redisClient.set(cacheKey(tenant, formId), "{not json");

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.data.published.version).toBe(1);
    expect(JSON.parse((await redisClient.get(cacheKey(tenant, formId)))!).version).toBe(1);
  });

  it("falls back to MongoDB when Redis is unavailable, and logs it", async () => {
    const { tenant, formId } = await published();
    vi.spyOn(redisClient, "get").mockRejectedValue(new Error("redis down"));
    vi.spyOn(redisClient, "set").mockRejectedValue(new Error("redis down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await getPublished(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.data.published.schema).toEqual(draftWith("Published label"));
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain("redis down");
  });

  it("is refreshed by a republish", async () => {
    const { tenant, formId } = await published();
    await getPublished(tenant, formId);
    await save(tenant, formId, draftWith("Version two"));
    await publish(tenant, formId);

    const res = await getPublished(tenant, formId);

    expect(res.body.data.published.version).toBe(2);
    expect(res.body.data.published.schema).toEqual(draftWith("Version two"));
  });

  it("does not let another tenant hit this tenant's cache entry", async () => {
    const { formId, tenant } = await published();
    await getPublished(tenant, formId);
    const other = await createTenant();

    const res = await getPublished(other, formId);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
  });

  it("is dropped when the form is deleted", async () => {
    const { tenant, formId } = await published();
    await getPublished(tenant, formId);

    await request(app)
      .delete(`/api/forms/${formId}`)
      .set("Authorization", auth(tenant));

    expect(await redisClient.get(cacheKey(tenant, formId))).toBeNull();
    expect((await getPublished(tenant, formId)).status).toBe(404);
  });
});
