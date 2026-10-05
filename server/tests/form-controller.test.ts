import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createForm,
  deleteForm,
  getFormById,
  getFormBySlug,
  listForms,
  updateForm,
} from "../src/controllers/form.controller.js";
import { authenticate } from "../src/middleware/auth.middleware.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  objectId,
  type TestSession,
  type TestUser,
} from "./helpers.js";
import {
  expectStandardError,
  resetRateLimits,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.17.5 — Form controller tests.
 *
 * No Form routes exist yet (8.17.6), so the handlers are exercised on a
 * test-only app that mirrors the intended wiring (authenticate ->
 * controller, with /slug/:slug before /:id), as authorization.test.ts
 * does for its guards. Everything else is real: tokens, middleware,
 * service, repository and MongoDB. Authorization middleware belongs to
 * 8.17.6 and is not wired here.
 */

const testApp = express();
testApp.use(express.json());

testApp.post("/forms", authenticate, createForm);
testApp.get("/forms", authenticate, listForms);
testApp.get("/forms/slug/:slug", authenticate, getFormBySlug);
testApp.get("/forms/:id", authenticate, getFormById);
testApp.patch("/forms/:id", authenticate, updateForm);
testApp.delete("/forms/:id", authenticate, deleteForm);
// Same handler without authenticate, to check the missing-auth guard.
testApp.get("/unauthenticated-forms", listForms);
testApp.use(errorHandler);

interface Tenant {
  user: TestUser;
  session: TestSession;
  projectId: string;
}

const createTenant = async (): Promise<Tenant> => {
  const user = await createTestUser();
  const session = await createTestSession(user);
  const project = await Project.create({
    organizationId: user.organizationId,
    createdBy: user.userId,
    name: "Project",
    slug: `project-${objectId()}`,
    status: "ACTIVE",
  });

  return { user, session, projectId: project._id.toString() };
};

const auth = (tenant: Tenant): string =>
  bearer(tenant.session.accessToken);

const validBody = (
  tenant: Tenant,
  overrides: Record<string, unknown> = {},
) => ({
  name: "Contact Form",
  description: "Collects contact details",
  slug: "contact-form",
  status: "draft",
  projectId: tenant.projectId,
  ...overrides,
});

const post = (tenant: Tenant, body: unknown) =>
  request(testApp)
    .post("/forms")
    .set("Authorization", auth(tenant))
    .send(body as object);

const createViaApi = async (
  tenant: Tenant,
  overrides: Record<string, unknown> = {},
): Promise<{ _id: string; slug: string }> => {
  const res = await post(tenant, validBody(tenant, overrides));
  expect(res.status).toBe(201);
  return res.body.data.form as { _id: string; slug: string };
};

let tenant: Tenant;

beforeAll(async () => {
  await Form.init();
});

beforeEach(async () => {
  await resetRateLimits();
  tenant = await createTenant();
});

describe("POST /forms", () => {
  it("creates a form and returns the success envelope", async () => {
    const res = await post(tenant, validBody(tenant));

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Form created successfully");
    expect(res.body.data.form).toMatchObject({
      name: "Contact Form",
      description: "Collects contact details",
      slug: "contact-form",
      status: "DRAFT",
      projectId: tenant.projectId,
      organizationId: tenant.user.organizationId,
      createdBy: tenant.user.userId,
    });
    expect(await Form.countDocuments({})).toBe(1);
  });

  it.each([
    ["missing name", (b: Record<string, unknown>) => delete b.name],
    ["missing slug", (b: Record<string, unknown>) => delete b.slug],
    ["missing status", (b: Record<string, unknown>) => delete b.status],
    [
      "missing projectId",
      (b: Record<string, unknown>) => delete b.projectId,
    ],
    [
      "invalid status",
      (b: Record<string, unknown>) => (b.status = "ACTIVE"),
    ],
    [
      "invalid slug",
      (b: Record<string, unknown>) => (b.slug = "Bad Slug!"),
    ],
    [
      "malformed projectId",
      (b: Record<string, unknown>) => (b.projectId = "nope"),
    ],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, mutate) => {
    const body: Record<string, unknown> = validBody(tenant);
    mutate(body);

    const res = await post(tenant, body);

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it.each([
    ["organizationId", objectId()],
    ["createdBy", objectId()],
    ["_id", objectId()],
    ["createdAt", "2000-01-01T00:00:00.000Z"],
    ["updatedAt", "2000-01-01T00:00:00.000Z"],
    ["unknownField", "x"],
  ])("rejects protected/unknown field %s", async (field, value) => {
    const res = await post(tenant, validBody(tenant, { [field]: value }));

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("rejects operator and prototype payloads", async () => {
    const bodies = [
      '{"name":"n","slug":"s","status":"DRAFT","projectId":"PID","$where":"1==1"}',
      '{"name":"n","slug":"s","status":"DRAFT","projectId":"PID","$set":{"organizationId":"x"}}',
      '{"name":"n","slug":"s","status":"DRAFT","projectId":"PID","__proto__":{"admin":true}}',
      '{"name":"n","slug":"s","status":"DRAFT","projectId":"PID","constructor":{"prototype":{"x":1}}}',
      '{"name":{"$ne":""},"slug":"s","status":"DRAFT","projectId":"PID"}',
      '{"name":"n","slug":"s","status":{"$gt":""},"projectId":"PID"}',
      '{"name":"n","slug":"s","status":"DRAFT","projectId":{"$ne":null}}',
    ];

    for (const raw of bodies) {
      const res = await request(testApp)
        .post("/forms")
        .set("Authorization", auth(tenant))
        .set("Content-Type", "application/json")
        .send(raw.replace("PID", tenant.projectId));

      expect(res.status, raw).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect(await Form.countDocuments({})).toBe(0);
    expect(
      ({} as Record<string, unknown>).admin,
    ).toBeUndefined();
  });

  it("propagates PROJECT_NOT_FOUND for a project of another organization", async () => {
    const other = await createTenant();

    const res = await post(
      tenant,
      validBody(tenant, { projectId: other.projectId }),
    );

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
    expect(await Form.countDocuments({})).toBe(0);
  });
});

describe("GET /forms", () => {
  it("lists the organization's forms", async () => {
    const other = await createTenant();
    await createViaApi(tenant, { slug: "one" });
    await createViaApi(tenant, { slug: "two" });
    await createViaApi(other, { slug: "foreign" });

    const res = await request(testApp)
      .get("/forms")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Forms retrieved successfully");
    expect(
      (res.body.data.forms as { slug: string }[]).map((f) => f.slug).sort(),
    ).toEqual(["one", "two"]);
  });

  it("filters by projectId and applies limit and skip", async () => {
    const second = await Project.create({
      organizationId: tenant.user.organizationId,
      createdBy: tenant.user.userId,
      name: "Second",
      slug: "second",
      status: "ACTIVE",
    });
    await createViaApi(tenant, { slug: "a" });
    await createViaApi(tenant, { slug: "b" });
    await createViaApi(tenant, {
      slug: "c",
      projectId: second._id.toString(),
    });

    const filtered = await request(testApp)
      .get(`/forms?projectId=${second._id}`)
      .set("Authorization", auth(tenant));
    const paged = await request(testApp)
      .get(`/forms?projectId=${tenant.projectId}&limit=1&skip=1`)
      .set("Authorization", auth(tenant));

    expect(
      (filtered.body.data.forms as { slug: string }[]).map((f) => f.slug),
    ).toEqual(["c"]);
    expect(
      (paged.body.data.forms as { slug: string }[]).map((f) => f.slug),
    ).toEqual(["a"]);
  });

  it("propagates PROJECT_NOT_FOUND for another organization's projectId", async () => {
    const other = await createTenant();

    const res = await request(testApp)
      .get(`/forms?projectId=${other.projectId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
  });

  it.each([
    "projectId=nope",
    "projectId[$ne]=x",
    "limit=0",
    "limit=101",
    "limit=abc",
    "limit=1.5",
    "skip=-1",
    "skip=abc",
    "skip=1.5",
    "$where=1",
    "status=DRAFT",
  ])("rejects query %s with 400 VALIDATION_ERROR", async (query) => {
    const res = await request(testApp)
      .get(`/forms?${query}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  });

  it("rejects organizationId in the query and leaks nothing", async () => {
    const other = await createTenant();
    await createViaApi(other, { slug: "foreign" });

    const res = await request(testApp)
      .get(`/forms?organizationId=${other.user.organizationId}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("foreign");
  });

  it("ignores organization headers", async () => {
    const other = await createTenant();
    await createViaApi(other, { slug: "foreign" });

    const res = await request(testApp)
      .get("/forms")
      .set("Authorization", auth(tenant))
      .set("X-Organization-Id", other.user.organizationId);

    expect(res.status).toBe(200);
    expect(res.body.data.forms).toEqual([]);
  });
});

describe("GET /forms/:id", () => {
  it("returns the form", async () => {
    const created = await createViaApi(tenant);

    const res = await request(testApp)
      .get(`/forms/${created._id}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Form retrieved successfully");
    expect(res.body.data.form).toEqual(created);
  });

  it.each(["not-an-id", "123", "z".repeat(24), "%24ne"])(
    "rejects malformed ID %j with 400 (not 500)",
    async (id) => {
      const res = await request(testApp)
        .get(`/forms/${id}`)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    },
  );

  it("propagates FORM_NOT_FOUND for a nonexistent or foreign form", async () => {
    const other = await createTenant();
    const foreign = await createViaApi(other);

    for (const id of [objectId(), foreign._id]) {
      const res = await request(testApp)
        .get(`/forms/${id}`)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(404);
      expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    }
  });
});

describe("GET /forms/slug/:slug", () => {
  it("returns the form and does not collide with /:id", async () => {
    const created = await createViaApi(tenant, { slug: "my-form" });

    const res = await request(testApp)
      .get("/forms/slug/my-form")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.data.form).toEqual(created);
  });

  it("normalizes the slug (trim and lowercase)", async () => {
    const created = await createViaApi(tenant, { slug: "my-form" });

    const res = await request(testApp)
      .get("/forms/slug/My-Form")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.data.form._id).toBe(created._id);
  });

  it.each(["bad_slug", "-lead", "a--b", "has space", "x".repeat(151)])(
    "rejects invalid slug %j with 400",
    async (slug) => {
      const res = await request(testApp)
        .get(`/forms/slug/${encodeURIComponent(slug)}`)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    },
  );

  it("is tenant scoped: another organization's slug is FORM_NOT_FOUND", async () => {
    const other = await createTenant();
    await createViaApi(other, { slug: "theirs" });

    const res = await request(testApp)
      .get("/forms/slug/theirs")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
  });
});

describe("PATCH /forms/:id", () => {
  it("updates the form", async () => {
    const created = await createViaApi(tenant);

    const res = await request(testApp)
      .patch(`/forms/${created._id}`)
      .set("Authorization", auth(tenant))
      .send({ name: "Renamed", status: " archived " });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Form updated successfully");
    expect(res.body.data.form).toMatchObject({
      name: "Renamed",
      status: "ARCHIVED",
      updatedBy: tenant.user.userId,
    });
  });

  it("rejects an empty body", async () => {
    const created = await createViaApi(tenant);

    const res = await request(testApp)
      .patch(`/forms/${created._id}`)
      .set("Authorization", auth(tenant))
      .send({});

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  });

  it.each([
    ["an invalid status", { status: "ACTIVE" }],
    ["an invalid slug", { slug: "Bad Slug!" }],
    ["a malformed projectId", { projectId: "nope" }],
    ["a whitespace-only name", { name: "  " }],
  ])("rejects %s", async (_label, body) => {
    const created = await createViaApi(tenant);

    const res = await request(testApp)
      .patch(`/forms/${created._id}`)
      .set("Authorization", auth(tenant))
      .send(body);

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  });

  it.each(["organizationId", "createdBy", "_id", "createdAt", "updatedAt"])(
    "rejects protected field %s and leaves the form unchanged",
    async (field) => {
      const created = await createViaApi(tenant);

      const res = await request(testApp)
        .patch(`/forms/${created._id}`)
        .set("Authorization", auth(tenant))
        .send({ name: "Changed", [field]: objectId() });

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect((await Form.findById(created._id).lean())?.name).toBe(
        "Contact Form",
      );
    },
  );

  it("rejects operator and prototype payloads", async () => {
    const created = await createViaApi(tenant);

    for (const raw of [
      '{"$where":"1==1"}',
      '{"$set":{"organizationId":"x"}}',
      '{"__proto__":{"admin":true}}',
      '{"constructor":{"prototype":{"x":1}}}',
      '{"name":{"$ne":""}}',
      '{"status":{"$gt":""}}',
      '{"projectId":{"$ne":null}}',
    ]) {
      const res = await request(testApp)
        .patch(`/forms/${created._id}`)
        .set("Authorization", auth(tenant))
        .set("Content-Type", "application/json")
        .send(raw);

      expect(res.status, raw).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    const stored = await Form.findById(created._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.organizationId.toString()).toBe(
      tenant.user.organizationId,
    );
  });

  it("rejects a malformed ID before validating the body", async () => {
    const res = await request(testApp)
      .patch("/forms/not-an-id")
      .set("Authorization", auth(tenant))
      .send({ name: "x" });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  });

  it("propagates FORM_NOT_FOUND and PROJECT_NOT_FOUND", async () => {
    const other = await createTenant();
    const created = await createViaApi(tenant);

    const missing = await request(testApp)
      .patch(`/forms/${objectId()}`)
      .set("Authorization", auth(tenant))
      .send({ name: "x" });
    const badProject = await request(testApp)
      .patch(`/forms/${created._id}`)
      .set("Authorization", auth(tenant))
      .send({ projectId: other.projectId });

    expect(missing.status).toBe(404);
    expectStandardError(missing.body as ErrorBody, "FORM_NOT_FOUND");
    expect(badProject.status).toBe(404);
    expectStandardError(badProject.body as ErrorBody, "PROJECT_NOT_FOUND");
  });
});

describe("DELETE /forms/:id", () => {
  it("deletes the form", async () => {
    const created = await createViaApi(tenant);

    const res = await request(testApp)
      .delete(`/forms/${created._id}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Form deleted successfully");
    expect(res.body.data).toBeUndefined();
    expect(await Form.countDocuments({ _id: created._id })).toBe(0);
  });

  it.each(["not-an-id", "123", "z".repeat(24)])(
    "rejects malformed ID %j with 400 and deletes nothing",
    async (id) => {
      await createViaApi(tenant);

      const res = await request(testApp)
        .delete(`/forms/${id}`)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(await Form.countDocuments({})).toBe(1);
    },
  );

  it("propagates FORM_NOT_FOUND for a missing or foreign form", async () => {
    const other = await createTenant();
    const foreign = await createViaApi(other);

    for (const id of [objectId(), foreign._id]) {
      const res = await request(testApp)
        .delete(`/forms/${id}`)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(404);
      expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    }

    expect(await Form.countDocuments({ _id: foreign._id })).toBe(1);
  });
});

describe("authentication context", () => {
  it("returns 401 without an access token", async () => {
    const res = await request(testApp).get("/forms");

    expect(res.status).toBe(401);
    expectStandardError(res.body as ErrorBody);
  });

  it("returns 401 for an invalid access token", async () => {
    const res = await request(testApp)
      .post("/forms")
      .set("Authorization", bearer("garbage"))
      .send(validBody(tenant));

    expect(res.status).toBe(401);
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("a handler reached without authenticate still refuses with 401", async () => {
    const res = await request(testApp).get("/unauthenticated-forms");

    expect(res.status).toBe(401);
    expectStandardError(res.body as ErrorBody);
  });

  it("derives organization and creator from the token, not the request", async () => {
    const other = await createTenant();

    const res = await post(
      tenant,
      validBody(tenant, { organizationId: other.user.organizationId }),
    );

    expect(res.status).toBe(400);

    const ok = await request(testApp)
      .post("/forms")
      .set("Authorization", auth(tenant))
      .set("X-Organization-Id", other.user.organizationId)
      .send(validBody(tenant));

    expect(ok.status).toBe(201);
    expect(ok.body.data.form.organizationId).toBe(
      tenant.user.organizationId,
    );
    expect(ok.body.data.form.createdBy).toBe(tenant.user.userId);
    expect(
      await Form.countDocuments({
        organizationId: new mongoose.Types.ObjectId(
          other.user.organizationId,
        ),
      }),
    ).toBe(0);
  });
});
