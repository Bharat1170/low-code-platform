import mongoose from "mongoose";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import app from "../src/app.js";
import {
  PERMISSIONS,
  type Permission,
} from "../src/constants/permissions.js";
import {
  OWNER_PERMISSIONS,
  ROLE_NAMES,
} from "../src/constants/roles.js";
import { Form } from "../src/models/form.model.js";
import { Organization } from "../src/models/organization.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { updateForm as updateFormService } from "../src/services/form.service.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  objectId,
  type TestSession,
  type TestUser,
} from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  resetRateLimits,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.17.7 — Form CRUD + security integration tests over the real
 * /api/forms routes (auth -> permission -> controller -> service ->
 * repository -> MongoDB). Per-route authorization and controller details
 * are covered in form-routes.test.ts and form-controller.test.ts; this
 * file exercises the whole backend as a client sees it.
 */

interface Tenant {
  user: TestUser;
  session: TestSession;
  projectId: string;
}

const createTenant = async (
  permissions: readonly string[] = OWNER_PERMISSIONS,
  roleName: (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES] = ROLE_NAMES.OWNER,
): Promise<Tenant> => {
  const user = await createTestUser();
  const role = await Role.create({
    organizationId: user.organizationId,
    name: roleName,
    description: "",
    permissions: [...permissions],
  });
  await User.updateOne(
    { _id: user.userId },
    { $set: { roleIds: [role._id] } },
  );
  const project = await makeProject(user);

  return {
    user,
    session: await createTestSession(user),
    projectId: project._id.toString(),
  };
};

const makeProject = (user: TestUser, slug = `project-${objectId()}`) =>
  Project.create({
    organizationId: user.organizationId,
    createdBy: user.userId,
    name: "Project",
    slug,
    status: "ACTIVE",
  });

const allBut = (permission: Permission): Promise<Tenant> =>
  createTenant(
    [
      PERMISSIONS.FORM_CREATE,
      PERMISSIONS.FORM_READ,
      PERMISSIONS.FORM_UPDATE,
      PERMISSIONS.FORM_DELETE,
      PERMISSIONS.PROJECT_READ,
    ].filter((p) => p !== permission),
    ROLE_NAMES.BUILDER,
  );

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
  request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send(body as object);

const get = (tenant: Tenant, path = "") =>
  request(app).get(`/api/forms${path}`).set("Authorization", auth(tenant));

const patch = (tenant: Tenant, id: string, body: unknown) =>
  request(app)
    .patch(`/api/forms/${id}`)
    .set("Authorization", auth(tenant))
    .send(body as object);

const del = (tenant: Tenant, id: string) =>
  request(app)
    .delete(`/api/forms/${id}`)
    .set("Authorization", auth(tenant));

const rawPost = (tenant: Tenant, raw: string) =>
  request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .set("Content-Type", "application/json")
    .send(raw);

const rawPatch = (tenant: Tenant, id: string, raw: string) =>
  request(app)
    .patch(`/api/forms/${id}`)
    .set("Authorization", auth(tenant))
    .set("Content-Type", "application/json")
    .send(raw);

interface FormBody {
  _id: string;
  organizationId: string;
  projectId: string;
  createdBy: string;
  updatedBy?: string;
  name: string;
  description: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const formOf = (res: request.Response): FormBody =>
  res.body.data.form as FormBody;

const createViaApi = async (
  tenant: Tenant,
  overrides: Record<string, unknown> = {},
): Promise<FormBody> => {
  const res = await post(tenant, validBody(tenant, overrides));
  expect(res.status).toBe(201);
  return formOf(res);
};

const expectCode = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expectStandardError(res.body as ErrorBody, code);
};

let owner: Tenant;

beforeAll(async () => {
  await Form.init();
  await Project.init();
});

beforeEach(async () => {
  await resetRateLimits();
  owner = await createTenant();
});

describe("A. create", () => {
  it("creates a form with the right envelope, organization and creator", async () => {
    const res = await post(owner, validBody(owner));

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Form created successfully");

    const form = formOf(res);
    expect(form).toMatchObject({
      organizationId: owner.user.organizationId,
      createdBy: owner.user.userId,
      projectId: owner.projectId,
      name: "Contact Form",
      description: "Collects contact details",
      slug: "contact-form",
      status: "DRAFT",
    });
    expect(Number.isNaN(Date.parse(form.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(form.updatedAt))).toBe(false);
    expect(form.updatedBy).toBeUndefined();

    const stored = await Form.findById(form._id).lean();
    expect(stored?.organizationId.toString()).toBe(
      owner.user.organizationId,
    );
    expect(stored?.createdBy.toString()).toBe(owner.user.userId);
  });

  it("defaults description to an empty string and normalizes values", async () => {
    const body: Record<string, unknown> = validBody(owner, {
      name: "  Padded  ",
      slug: "  Mixed-Case ",
      status: " published ",
    });
    delete body.description;

    const form = formOf(await post(owner, body));

    expect(form).toMatchObject({
      name: "Padded",
      description: "",
      slug: "mixed-case",
      status: "PUBLISHED",
    });
  });

  it("accepts a project of the same organization", async () => {
    const second = await makeProject(owner.user);

    const res = await post(
      owner,
      validBody(owner, { projectId: second._id.toString() }),
    );

    expect(res.status).toBe(201);
    expect(formOf(res).projectId).toBe(second._id.toString());
  });

  it("returns the same PROJECT_NOT_FOUND for a missing and a foreign project", async () => {
    const other = await createTenant();

    const missing = await post(
      owner,
      validBody(owner, { projectId: objectId() }),
    );
    const foreign = await post(
      owner,
      validBody(owner, { projectId: other.projectId }),
    );

    expectCode(missing, 404, "PROJECT_NOT_FOUND");
    expectCode(foreign, 404, "PROJECT_NOT_FOUND");
    expect(foreign.body).toEqual(missing.body);
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("rejects a duplicate slug within one organization (unique index)", async () => {
    await createViaApi(owner, { slug: "dup" });

    const res = await post(owner, validBody(owner, { slug: "dup" }));

    expect(res.status).not.toBe(201);
    expect(
      await Form.countDocuments({
        organizationId: owner.user.organizationId,
        slug: "dup",
      }),
    ).toBe(1);
    expectNoInternals(res.body);
  });

  it("KNOWN GAP: a duplicate slug currently surfaces as a generic 500, not a 409", async () => {
    await createViaApi(owner, { slug: "dup" });

    const res = await post(owner, validBody(owner, { slug: "dup" }));

    expect(res.status).toBe(500);
    expectStandardError(res.body as ErrorBody);
  });

  it("allows the same slug in different organizations", async () => {
    const other = await createTenant();

    const a = await createViaApi(owner, { slug: "shared" });
    const b = await createViaApi(other, { slug: "shared" });

    expect(a.organizationId).toBe(owner.user.organizationId);
    expect(b.organizationId).toBe(other.user.organizationId);
    expect(await Form.countDocuments({ slug: "shared" })).toBe(2);
  });

  it("client organizationId and createdBy cannot override the authenticated identity", async () => {
    const other = await createTenant();

    for (const override of [
      { organizationId: other.user.organizationId },
      { createdBy: other.user.userId },
    ]) {
      const res = await post(owner, validBody(owner, override));
      expectCode(res, 400, "VALIDATION_ERROR");
    }

    expect(await Form.countDocuments({})).toBe(0);

    const ok = await request(app)
      .post("/api/forms")
      .set("Authorization", auth(owner))
      .set("X-Organization-Id", other.user.organizationId)
      .set("X-Created-By", other.user.userId)
      .send(validBody(owner));
    expect(ok.status).toBe(201);
    expect(formOf(ok).organizationId).toBe(owner.user.organizationId);
    expect(formOf(ok).createdBy).toBe(owner.user.userId);
  });

  it.each([
    ["name", { name: "   " }],
    ["name length", { name: "n".repeat(151) }],
    ["slug", { slug: "Bad Slug!" }],
    ["slug length", { slug: "s".repeat(151) }],
    ["status", { status: "ACTIVE" }],
    ["projectId", { projectId: "nope" }],
    ["description length", { description: "d".repeat(501) }],
  ])("rejects an invalid %s with 400", async (_label, override) => {
    const res = await post(owner, validBody(owner, override));

    expectCode(res, 400, "VALIDATION_ERROR");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it.each(["name", "slug", "status", "projectId"])(
    "rejects a missing %s with 400",
    async (field) => {
      const body: Record<string, unknown> = validBody(owner);
      delete body[field];

      expectCode(await post(owner, body), 400, "VALIDATION_ERROR");
    },
  );
});

describe("B. list", () => {
  it("returns only the authenticated organization's forms", async () => {
    const other = await createTenant();
    await createViaApi(owner, { slug: "a-1" });
    await createViaApi(owner, { slug: "a-2" });
    await createViaApi(other, { slug: "b-1" });

    const res = await get(owner);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Forms retrieved successfully");
    const forms = res.body.data.forms as FormBody[];
    expect(forms.map((f) => f.slug).sort()).toEqual(["a-1", "a-2"]);
    for (const form of forms) {
      expect(form.organizationId).toBe(owner.user.organizationId);
    }
    expect(JSON.stringify(res.body)).not.toContain("b-1");
  });

  it("filters by projectId", async () => {
    const second = await makeProject(owner.user);
    await createViaApi(owner, { slug: "in-first" });
    await createViaApi(owner, {
      slug: "in-second",
      projectId: second._id.toString(),
    });

    const res = await get(owner, `?projectId=${second._id}`);

    expect(
      (res.body.data.forms as FormBody[]).map((f) => f.slug),
    ).toEqual(["in-second"]);
  });

  it("cannot be used to probe another organization's project", async () => {
    const other = await createTenant();
    await createViaApi(other, { slug: "theirs" });

    const foreign = await get(owner, `?projectId=${other.projectId}`);
    const missing = await get(owner, `?projectId=${objectId()}`);

    expectCode(foreign, 404, "PROJECT_NOT_FOUND");
    expectCode(missing, 404, "PROJECT_NOT_FOUND");
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain("theirs");
  });

  describe("limit and skip", () => {
    beforeEach(async () => {
      for (const slug of ["p1", "p2", "p3", "p4", "p5"]) {
        await createViaApi(owner, { slug });
      }
    });

    const slugs = (res: request.Response): string[] =>
      (res.body.data.forms as FormBody[]).map((f) => f.slug);

    it("applies limit", async () => {
      expect(slugs(await get(owner, "?limit=2"))).toEqual(["p5", "p4"]);
    });

    it("applies skip", async () => {
      expect(slugs(await get(owner, "?skip=3"))).toEqual(["p2", "p1"]);
    });

    it("enforces the maximum limit of 100", async () => {
      expect((await get(owner, "?limit=100")).status).toBe(200);
      expectCode(await get(owner, "?limit=101"), 400, "VALIDATION_ERROR");
    });
  });

  it("caps the default page at 20 forms", async () => {
    await Form.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        organizationId: owner.user.organizationId,
        projectId: owner.projectId,
        name: `Bulk ${i}`,
        slug: `bulk-${i}`,
        status: "DRAFT",
        createdBy: owner.user.userId,
      })),
    );

    expect((await get(owner)).body.data.forms).toHaveLength(20);
  });

  it("organizationId in the query cannot change the tenant", async () => {
    const other = await createTenant();
    await createViaApi(other, { slug: "theirs" });

    const res = await get(owner, `?organizationId=${other.user.organizationId}`);

    expectCode(res, 400, "VALIDATION_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("theirs");
  });

  it("X-Organization-Id cannot change the tenant", async () => {
    const other = await createTenant();
    await createViaApi(other, { slug: "theirs" });

    const res = await request(app)
      .get("/api/forms")
      .set("Authorization", auth(owner))
      .set("X-Organization-Id", other.user.organizationId);

    expect(res.status).toBe(200);
    expect(res.body.data.forms).toEqual([]);
  });
});

describe("C. get", () => {
  it("gets a form by ID and by slug", async () => {
    const created = await createViaApi(owner, { slug: "my-form" });

    const byId = await get(owner, `/${created._id}`);
    const bySlug = await get(owner, "/slug/my-form");

    expect(byId.status).toBe(200);
    expect(byId.body.message).toBe("Form retrieved successfully");
    expect(formOf(byId)).toEqual(created);
    expect(bySlug.status).toBe(200);
    expect(formOf(bySlug)).toEqual(created);
  });

  it("returns FORM_NOT_FOUND for another tenant's form, a missing form and a foreign slug", async () => {
    const other = await createTenant();
    const theirs = await createViaApi(other, { slug: "same-slug" });

    const foreignId = await get(owner, `/${theirs._id}`);
    const missingId = await get(owner, `/${objectId()}`);
    const foreignSlug = await get(owner, "/slug/same-slug");

    expectCode(foreignId, 404, "FORM_NOT_FOUND");
    expectCode(missingId, 404, "FORM_NOT_FOUND");
    expectCode(foreignSlug, 404, "FORM_NOT_FOUND");
    expect(foreignId.body).toEqual(missingId.body);
  });

  it.each(["not-an-id", "123", "z".repeat(24)])(
    "rejects malformed ID %j with 400",
    async (id) => {
      expectCode(await get(owner, `/${id}`), 400, "VALIDATION_ERROR");
    },
  );

  it.each(["bad_slug", "-lead", "a--b", "x".repeat(151)])(
    "rejects invalid slug %j with 400",
    async (slug) => {
      expectCode(
        await get(owner, `/slug/${encodeURIComponent(slug)}`),
        400,
        "VALIDATION_ERROR",
      );
    },
  );
});

describe("D. update", () => {
  it("updates name, description, slug and status", async () => {
    const created = await createViaApi(owner);

    for (const [field, value, expected] of [
      ["name", "Renamed", "Renamed"],
      ["description", "New description", "New description"],
      ["slug", "New-Slug", "new-slug"],
      ["status", "archived", "ARCHIVED"],
    ] as const) {
      const res = await patch(owner, created._id, { [field]: value });

      expect(res.status, field).toBe(200);
      expect(res.body.message).toBe("Form updated successfully");
      expect(formOf(res)[field]).toBe(expected);
      expect((await Form.findById(created._id).lean())?.[field]).toBe(
        expected,
      );
    }
  });

  it("changes only the supplied field and keeps createdAt", async () => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, { name: "Only Name" });

    expect(formOf(res)).toMatchObject({
      name: "Only Name",
      description: created.description,
      slug: created.slug,
      status: created.status,
      createdBy: created.createdBy,
      createdAt: created.createdAt,
    });
  });

  it("moves the form to another project of the same organization", async () => {
    const created = await createViaApi(owner);
    const second = await makeProject(owner.user);

    const res = await patch(owner, created._id, {
      projectId: second._id.toString(),
    });

    expect(res.status).toBe(200);
    expect(formOf(res).projectId).toBe(second._id.toString());
  });

  it("rejects a foreign or nonexistent project with PROJECT_NOT_FOUND", async () => {
    const other = await createTenant();
    const created = await createViaApi(owner);

    const foreign = await patch(owner, created._id, {
      projectId: other.projectId,
    });
    const missing = await patch(owner, created._id, {
      projectId: objectId(),
    });

    expectCode(foreign, 404, "PROJECT_NOT_FOUND");
    expectCode(missing, 404, "PROJECT_NOT_FOUND");
    expect(
      (await Form.findById(created._id).lean())?.projectId.toString(),
    ).toBe(owner.projectId);
  });

  it("returns FORM_NOT_FOUND for another organization's form and changes nothing", async () => {
    const other = await createTenant();
    const theirs = await createViaApi(other);

    const res = await patch(owner, theirs._id, { name: "Hijacked" });

    expectCode(res, 404, "FORM_NOT_FOUND");
    expect((await Form.findById(theirs._id).lean())?.name).toBe(
      "Contact Form",
    );
  });

  it("always sets updatedBy from the authenticated user", async () => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, { name: "Renamed" });

    expect(formOf(res).updatedBy).toBe(owner.user.userId);

    const attempt = await patch(owner, created._id, {
      name: "Again",
      updatedBy: objectId(),
    });
    expectCode(attempt, 400, "VALIDATION_ERROR");
    expect(
      (await Form.findById(created._id).lean())?.updatedBy?.toString(),
    ).toBe(owner.user.userId);
  });

  it.each([
    ["organizationId", () => objectId()],
    ["createdBy", () => objectId()],
    ["_id", () => objectId()],
  ])("%s cannot be changed", async (field, value) => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, {
      name: "Changed",
      [field]: value(),
    });

    expectCode(res, 400, "VALIDATION_ERROR");

    const stored = await Form.findById(created._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?._id.toString()).toBe(created._id);
    expect(stored?.organizationId.toString()).toBe(
      owner.user.organizationId,
    );
    expect(stored?.createdBy.toString()).toBe(owner.user.userId);
  });

  it("sets currentDraftVersionId and publishedVersionId only through the trusted service path", async () => {
    const created = await createViaApi(owner);
    const draft = new mongoose.Types.ObjectId();
    const published = new mongoose.Types.ObjectId();

    // Not settable through the API...
    for (const body of [
      { currentDraftVersionId: draft.toString() },
      { publishedVersionId: published.toString() },
    ]) {
      expectCode(
        await patch(owner, created._id, body),
        400,
        "VALIDATION_ERROR",
      );
    }
    expect(
      (await Form.findById(created._id).lean())?.currentDraftVersionId,
    ).toBeUndefined();

    // ...but supported by the service for later versioning/publishing.
    const updated = await updateFormService(
      {
        userId: owner.user.userId,
        organizationId: owner.user.organizationId,
        sessionId: owner.session.sessionId,
      },
      created._id,
      { currentDraftVersionId: draft, publishedVersionId: published },
    );

    expect(updated.currentDraftVersionId?.toString()).toBe(draft.toString());
    expect(updated.publishedVersionId?.toString()).toBe(
      published.toString(),
    );
    expect(updated.updatedBy?.toString()).toBe(owner.user.userId);
  });

  it("rejects an empty update", async () => {
    const created = await createViaApi(owner);

    expectCode(await patch(owner, created._id, {}), 400, "VALIDATION_ERROR");
  });

  it.each([
    ["status", { status: "ACTIVE" }],
    ["slug", { slug: "Bad Slug!" }],
    ["projectId", { projectId: "nope" }],
    ["name", { name: "  " }],
    ["name length", { name: "n".repeat(151) }],
    ["description length", { description: "d".repeat(501) }],
  ])("rejects an invalid %s", async (_label, body) => {
    const created = await createViaApi(owner);

    expectCode(await patch(owner, created._id, body), 400, "VALIDATION_ERROR");
    expect((await Form.findById(created._id).lean())?.name).toBe(
      "Contact Form",
    );
  });

  it("propagates the duplicate-key behavior when the slug collides", async () => {
    await createViaApi(owner, { slug: "taken" });
    const other = await createViaApi(owner, { slug: "other" });

    const res = await patch(owner, other._id, { slug: "taken" });

    expect(res.status).not.toBe(200);
    expectNoInternals(res.body);
    expect((await Form.findById(other._id).lean())?.slug).toBe("other");
  });
});

describe("E. delete", () => {
  it("deletes a same-tenant form, which can no longer be retrieved", async () => {
    const created = await createViaApi(owner, { slug: "gone" });

    const res = await del(owner, created._id);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Form deleted successfully");
    expect(res.body.data).toBeUndefined();
    expect(await Form.countDocuments({ _id: created._id })).toBe(0);

    expectCode(await get(owner, `/${created._id}`), 404, "FORM_NOT_FOUND");
    expectCode(await get(owner, "/slug/gone"), 404, "FORM_NOT_FOUND");
    expect((await get(owner)).body.data.forms).toEqual([]);
  });

  it("returns FORM_NOT_FOUND for another tenant's form and keeps it", async () => {
    const other = await createTenant();
    const theirs = await createViaApi(other);

    expectCode(await del(owner, theirs._id), 404, "FORM_NOT_FOUND");
    expect(await Form.countDocuments({ _id: theirs._id })).toBe(1);
  });

  it("returns FORM_NOT_FOUND for a missing form and on a repeated delete", async () => {
    const created = await createViaApi(owner);

    await del(owner, created._id);

    expectCode(await del(owner, created._id), 404, "FORM_NOT_FOUND");
    expectCode(await del(owner, objectId()), 404, "FORM_NOT_FOUND");
  });

  it("rejects a malformed ID with 400 and deletes nothing", async () => {
    await createViaApi(owner);

    expectCode(await del(owner, "not-an-id"), 400, "VALIDATION_ERROR");
    expect(await Form.countDocuments({})).toBe(1);
  });

  it("a forbidden delete does not modify the database", async () => {
    const created = await createViaApi(owner);

    // A user of the SAME organization holding every permission but delete.
    const sameOrg = await createTestUser({
      organizationId: owner.user.organizationId,
    });
    const role = await Role.create({
      organizationId: owner.user.organizationId,
      name: ROLE_NAMES.VIEWER,
      description: "",
      permissions: [PERMISSIONS.FORM_READ, PERMISSIONS.FORM_UPDATE],
    });
    await User.updateOne(
      { _id: sameOrg.userId },
      { $set: { roleIds: [role._id] } },
    );
    const viewer: Tenant = {
      user: sameOrg,
      session: await createTestSession(sameOrg),
      projectId: owner.projectId,
    };

    const res = await del(viewer, created._id);

    expectCode(res, 403, "FORBIDDEN");
    expect(await Form.countDocuments({ _id: created._id })).toBe(1);
  });
});

describe("F. authorization smoke", () => {
  it("rejects unauthenticated create with 401", async () => {
    const res = await request(app).post("/api/forms").send(validBody(owner));

    expect(res.status).toBe(401);
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("returns 403 for a user lacking the needed permission", async () => {
    const created = await createViaApi(owner);
    const noCreate = await allBut(PERMISSIONS.FORM_CREATE);
    const noRead = await allBut(PERMISSIONS.FORM_READ);
    const noUpdate = await allBut(PERMISSIONS.FORM_UPDATE);
    const noDelete = await allBut(PERMISSIONS.FORM_DELETE);

    const responses = await Promise.all([
      post(noCreate, validBody(noCreate)),
      get(noRead),
      get(noRead, `/${created._id}`),
      get(noRead, "/slug/contact-form"),
      patch(noUpdate, created._id, { name: "x" }),
      del(noDelete, created._id),
    ]);

    for (const res of responses) {
      expectCode(res, 403, "FORBIDDEN");
    }

    expect(await Form.countDocuments({})).toBe(1);
    expect((await Form.findById(created._id).lean())?.name).toBe(
      "Contact Form",
    );
  });

  it.each(["SUSPENDED", "DELETED"])(
    "a %s account cannot perform any form operation",
    async (status) => {
      const created = await createViaApi(owner);
      await User.updateOne({ _id: owner.user.userId }, { $set: { status } });

      const responses = await Promise.all([
        post(owner, validBody(owner, { slug: "x" })),
        get(owner),
        get(owner, `/${created._id}`),
        patch(owner, created._id, { name: "x" }),
        del(owner, created._id),
      ]);

      for (const res of responses) {
        expectCode(res, 403, "ACCOUNT_NOT_ACTIVE");
      }
      expect(await Form.countDocuments({})).toBe(1);
    },
  );

  it("a suspended organization cannot perform form operations", async () => {
    await Organization.updateOne(
      { _id: owner.user.organizationId },
      { $set: { status: "SUSPENDED" } },
    );

    expectCode(await get(owner), 403, "ACCOUNT_NOT_ACTIVE");
  });

  it("form permissions do not grant project permissions", async () => {
    const formsOnly = await createTenant(
      [
        PERMISSIONS.FORM_CREATE,
        PERMISSIONS.FORM_READ,
        PERMISSIONS.FORM_UPDATE,
        PERMISSIONS.FORM_DELETE,
      ],
      ROLE_NAMES.BUILDER,
    );

    const responses = await Promise.all([
      request(app).get("/api/projects").set("Authorization", auth(formsOnly)),
      request(app)
        .post("/api/projects")
        .set("Authorization", auth(formsOnly))
        .send({ name: "P", slug: "p", status: "active" }),
    ]);

    for (const res of responses) {
      expectCode(res, 403, "FORBIDDEN");
    }
  });
});

describe("G. tenant isolation / IDOR", () => {
  it("tenant A cannot read, update, delete or list tenant B's forms", async () => {
    const b = await createTenant();
    const theirs = await createViaApi(b, { slug: "b-secret" });

    expectCode(await get(owner, `/${theirs._id}`), 404, "FORM_NOT_FOUND");
    expectCode(await get(owner, "/slug/b-secret"), 404, "FORM_NOT_FOUND");
    expectCode(
      await patch(owner, theirs._id, { name: "Hijacked" }),
      404,
      "FORM_NOT_FOUND",
    );
    expectCode(await del(owner, theirs._id), 404, "FORM_NOT_FOUND");
    expect(JSON.stringify((await get(owner)).body)).not.toContain("b-secret");

    const stored = await Form.findById(theirs._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.organizationId.toString()).toBe(b.user.organizationId);
  });

  it("tenant A cannot create a form under tenant B's project", async () => {
    const b = await createTenant();

    const res = await post(owner, validBody(owner, { projectId: b.projectId }));

    expectCode(res, 404, "PROJECT_NOT_FOUND");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("identical slugs across organizations stay isolated", async () => {
    const b = await createTenant();
    const a1 = await createViaApi(owner, { slug: "shared", name: "A's form" });
    const b1 = await createViaApi(b, { slug: "shared", name: "B's form" });

    const bySlugA = formOf(await get(owner, "/slug/shared"));
    const bySlugB = formOf(await get(b, "/slug/shared"));

    expect(bySlugA._id).toBe(a1._id);
    expect(bySlugA.name).toBe("A's form");
    expect(bySlugB._id).toBe(b1._id);
    expect(bySlugB.name).toBe("B's form");

    await patch(owner, a1._id, { name: "A renamed" });
    expect((await Form.findById(b1._id).lean())?.name).toBe("B's form");
  });
});

describe("H. mass assignment and operator safety", () => {
  const protectedFields: [string, () => unknown][] = [
    ["organizationId", objectId],
    ["createdBy", objectId],
    ["updatedBy", objectId],
    ["_id", objectId],
    ["currentDraftVersionId", objectId],
    ["publishedVersionId", objectId],
    ["createdAt", () => "2000-01-01T00:00:00.000Z"],
    ["updatedAt", () => "2000-01-01T00:00:00.000Z"],
    ["unknownField", () => "x"],
    ["prototype", () => ({ polluted: true })],
    ["constructor", () => ({ polluted: true })],
  ];

  it.each(protectedFields)("POST rejects %s", async (field, value) => {
    const res = await post(owner, validBody(owner, { [field]: value() }));

    expectCode(res, 400, "VALIDATION_ERROR");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it.each(protectedFields)("PATCH rejects %s", async (field, value) => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, {
      name: "Changed",
      [field]: value(),
    });

    expectCode(res, 400, "VALIDATION_ERROR");

    const stored = await Form.findById(created._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.organizationId.toString()).toBe(
      owner.user.organizationId,
    );
    expect(stored?.createdBy.toString()).toBe(owner.user.userId);
    expect(stored?.updatedBy).toBeUndefined();
    expect(stored?.currentDraftVersionId).toBeUndefined();
    expect(stored?.publishedVersionId).toBeUndefined();
  });

  it("POST rejects $set, $where, $or, __proto__ and operator values", async () => {
    const base = `"name":"n","slug":"s","status":"DRAFT","projectId":"${owner.projectId}"`;

    for (const raw of [
      `{${base},"$set":{"organizationId":"${objectId()}"}}`,
      `{${base},"$where":"1==1"}`,
      `{${base},"$or":[{"name":"x"}]}`,
      `{${base},"__proto__":{"admin":true}}`,
      `{${base},"constructor":{"prototype":{"admin":true}}}`,
      `{"name":{"$ne":""},"slug":"s","status":"DRAFT","projectId":"${owner.projectId}"}`,
      `{"name":"n","slug":{"$ne":null},"status":"DRAFT","projectId":"${owner.projectId}"}`,
      `{"name":"n","slug":"s","status":{"$gt":""},"projectId":"${owner.projectId}"}`,
      `{"name":"n","slug":"s","status":"DRAFT","projectId":{"$ne":null}}`,
    ]) {
      const res = await rawPost(owner, raw);

      expect(res.status, raw).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect(await Form.countDocuments({})).toBe(0);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("PATCH rejects $set, $where, $or, __proto__ and operator values", async () => {
    const created = await createViaApi(owner);

    for (const raw of [
      `{"$set":{"organizationId":"${objectId()}"}}`,
      '{"$where":"1==1"}',
      '{"$or":[{"name":"x"}]}',
      '{"__proto__":{"admin":true}}',
      '{"name":"x","constructor":{"prototype":{"admin":true}}}',
      '{"name":{"$ne":""}}',
      '{"status":{"$gt":""}}',
      '{"projectId":{"$ne":null}}',
    ]) {
      const res = await rawPatch(owner, created._id, raw);

      expect(res.status, raw).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    const stored = await Form.findById(created._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.organizationId.toString()).toBe(
      owner.user.organizationId,
    );
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("list query operators are rejected", async () => {
    for (const query of [
      "$where=1",
      "$or[0][name]=x",
      "projectId[$ne]=x",
      "limit[$gt]=1",
    ]) {
      expectCode(await get(owner, `?${query}`), 400, "VALIDATION_ERROR");
    }
  });
});
