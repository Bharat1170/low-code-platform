import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import app from "../src/app.js";
import {
  OWNER_PERMISSIONS,
  ROLE_NAMES,
} from "../src/constants/roles.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
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
import {
  expectStandardError,
  resetRateLimits,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.16.8 — Project CRUD integration tests over the real /api/projects
 * routes (auth -> permission -> controller -> service -> repository ->
 * MongoDB). Tenant-isolation and injection coverage lives in
 * security-project-tenant.test.ts.
 */

interface Tenant {
  user: TestUser;
  session: TestSession;
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

  return { user, session: await createTestSession(user) };
};

const auth = (tenant: Tenant): string =>
  bearer(tenant.session.accessToken);

const post = (tenant: Tenant, body: unknown) =>
  request(app)
    .post("/api/projects")
    .set("Authorization", auth(tenant))
    .send(body as object);

const get = (tenant: Tenant, path = "") =>
  request(app)
    .get(`/api/projects${path}`)
    .set("Authorization", auth(tenant));

const patch = (tenant: Tenant, id: string, body: unknown) =>
  request(app)
    .patch(`/api/projects/${id}`)
    .set("Authorization", auth(tenant))
    .send(body as object);

const del = (tenant: Tenant, id: string) =>
  request(app)
    .delete(`/api/projects/${id}`)
    .set("Authorization", auth(tenant));

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ProjectBody {
  _id: string;
  organizationId: string;
  createdBy: string;
  name: string;
  description: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const projectOf = (res: request.Response): ProjectBody =>
  res.body.data.project as ProjectBody;

const validBody = {
  name: "Customer Onboarding",
  description: "Collects customer details",
  slug: "customer-onboarding",
  status: "ACTIVE",
};

const createViaApi = async (
  tenant: Tenant,
  overrides: Record<string, unknown> = {},
): Promise<ProjectBody> => {
  const res = await post(tenant, { ...validBody, ...overrides });
  expect(res.status).toBe(201);
  return projectOf(res);
};

let owner: Tenant;

beforeEach(async () => {
  await resetRateLimits();
  owner = await createTenant();
});

describe("create", () => {
  it("creates a project scoped to the authenticated user", async () => {
    const res = await post(owner, validBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Project created successfully");

    const project = projectOf(res);
    expect(project).toMatchObject({
      organizationId: owner.user.organizationId,
      createdBy: owner.user.userId,
      ...validBody,
    });
    expect(typeof project._id).toBe("string");
    expect(Number.isNaN(Date.parse(project.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(project.updatedAt))).toBe(false);

    const stored = await Project.findById(project._id).lean();
    expect(stored?.organizationId.toString()).toBe(
      owner.user.organizationId,
    );
    expect(stored?.createdBy.toString()).toBe(owner.user.userId);
    expect(stored?.slug).toBe(validBody.slug);
  });

  it("defaults description to an empty string when omitted", async () => {
    const { description: _omit, ...withoutDescription } = validBody;

    const res = await post(owner, withoutDescription);

    expect(res.status).toBe(201);
    expect(projectOf(res).description).toBe("");

    const stored = await Project.findById(projectOf(res)._id).lean();
    expect(stored?.description).toBe("");
  });

  it("trims and normalizes name, description, slug and status", async () => {
    const res = await post(owner, {
      name: "  My Project  ",
      description: "  some text  ",
      slug: "  My-Project  ",
      status: "  draft  ",
    });

    expect(res.status).toBe(201);
    expect(projectOf(res)).toMatchObject({
      name: "My Project",
      description: "some text",
      slug: "my-project",
      status: "DRAFT",
    });

    const stored = await Project.findById(projectOf(res)._id).lean();
    expect(stored).toMatchObject({
      name: "My Project",
      description: "some text",
      slug: "my-project",
      status: "DRAFT",
    });
  });
});

describe("get by ID", () => {
  it("returns the created project", async () => {
    const created = await createViaApi(owner);

    const res = await get(owner, `/${created._id}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Project retrieved successfully");
    expect(projectOf(res)).toEqual(created);
  });

  it("returns 404 PROJECT_NOT_FOUND for a nonexistent ID", async () => {
    const res = await get(owner, `/${objectId()}`);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
  });
});

describe("list", () => {
  it("returns all of the organization's projects and nothing else", async () => {
    const other = await createTenant();
    await createViaApi(owner, { slug: "one" });
    await createViaApi(owner, { slug: "two" });
    await createViaApi(owner, { slug: "three" });
    await createViaApi(other, { slug: "foreign" });

    const res = await get(owner);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Projects retrieved successfully");

    const projects = res.body.data.projects as ProjectBody[];
    expect(projects.map((p) => p.slug).sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
    for (const project of projects) {
      expect(project.organizationId).toBe(owner.user.organizationId);
    }
  });

  it("returns an empty list when the organization has no projects", async () => {
    const res = await get(owner);

    expect(res.status).toBe(200);
    expect(res.body.data.projects).toEqual([]);
  });

  describe("limit and skip", () => {
    const slugs = ["p1", "p2", "p3", "p4", "p5"];

    const slugsOf = (res: request.Response): string[] =>
      (res.body.data.projects as ProjectBody[]).map((p) => p.slug);

    beforeEach(async () => {
      // Created sequentially so newest-first ordering is deterministic.
      for (const slug of slugs) {
        await createViaApi(owner, { slug });
      }
    });

    it("orders newest first", async () => {
      const res = await get(owner);

      expect(slugsOf(res)).toEqual(["p5", "p4", "p3", "p2", "p1"]);
    });

    it("applies limit", async () => {
      const res = await get(owner, "?limit=2");

      expect(res.status).toBe(200);
      expect(slugsOf(res)).toEqual(["p5", "p4"]);
    });

    it("applies skip", async () => {
      const res = await get(owner, "?skip=3");

      expect(res.status).toBe(200);
      expect(slugsOf(res)).toEqual(["p2", "p1"]);
    });

    it("applies limit and skip together", async () => {
      const res = await get(owner, "?limit=2&skip=1");

      expect(res.status).toBe(200);
      expect(slugsOf(res)).toEqual(["p4", "p3"]);
    });

    it("returns an empty page when skip passes the end", async () => {
      const res = await get(owner, "?skip=50");

      expect(res.status).toBe(200);
      expect(slugsOf(res)).toEqual([]);
    });

    it("accepts the maximum limit of 100", async () => {
      const res = await get(owner, "?limit=100");

      expect(res.status).toBe(200);
      expect(slugsOf(res)).toHaveLength(5);
    });

    it.each([
      "limit=101",
      "limit=0",
      "limit=-1",
      "limit=1.5",
      "limit=abc",
      "skip=-1",
      "skip=1.5",
      "skip=abc",
    ])("rejects %s with 400 VALIDATION_ERROR", async (query) => {
      const res = await get(owner, `?${query}`);

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    });
  });

  it("returns at most the default limit of 20 when none is given", async () => {
    await Project.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        organizationId: owner.user.organizationId,
        createdBy: owner.user.userId,
        name: `Bulk ${i}`,
        slug: `bulk-${i}`,
        status: "ACTIVE",
      })),
    );

    const res = await get(owner);

    expect(res.status).toBe(200);
    expect(res.body.data.projects).toHaveLength(20);
  });
});

describe("update", () => {
  it("updates all editable fields", async () => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, {
      name: "Renamed",
      description: "New description",
      slug: "renamed",
      status: "archived",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Project updated successfully");
    expect(projectOf(res)).toMatchObject({
      _id: created._id,
      name: "Renamed",
      description: "New description",
      slug: "renamed",
      status: "ARCHIVED",
      organizationId: owner.user.organizationId,
      createdBy: owner.user.userId,
      createdAt: created.createdAt,
    });

    const stored = await Project.findById(created._id).lean();
    expect(stored).toMatchObject({
      name: "Renamed",
      description: "New description",
      slug: "renamed",
      status: "ARCHIVED",
    });
  });

  it("changes only the supplied field on a partial update", async () => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, { name: "Only Name" });

    expect(res.status).toBe(200);
    expect(projectOf(res)).toMatchObject({
      name: "Only Name",
      description: created.description,
      slug: created.slug,
      status: created.status,
      organizationId: created.organizationId,
      createdBy: created.createdBy,
    });

    const stored = await Project.findById(created._id).lean();
    expect(stored?.description).toBe(created.description);
    expect(stored?.slug).toBe(created.slug);
    expect(stored?.status).toBe(created.status);
  });

  it("normalizes slug and status on update", async () => {
    const created = await createViaApi(owner);

    const res = await patch(owner, created._id, {
      slug: "  New-Slug ",
      status: " paused ",
    });

    expect(res.status).toBe(200);
    expect(projectOf(res)).toMatchObject({
      slug: "new-slug",
      status: "PAUSED",
    });
  });

  it("advances updatedAt and keeps createdAt", async () => {
    const created = await createViaApi(owner);

    await wait(25);
    const res = await patch(owner, created._id, { name: "Later" });

    expect(res.status).toBe(200);
    const updated = projectOf(res);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(
      Date.parse(created.updatedAt),
    );
  });

  it("returns 404 PROJECT_NOT_FOUND for a nonexistent ID", async () => {
    const res = await patch(owner, objectId(), { name: "Nope" });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
  });
});

describe("delete", () => {
  it("deletes the project and it can no longer be retrieved", async () => {
    const created = await createViaApi(owner);

    const res = await del(owner, created._id);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Project deleted successfully");
    expect(res.body.data).toBeUndefined();

    expect(await Project.countDocuments({ _id: created._id })).toBe(0);

    const after = await get(owner, `/${created._id}`);
    expect(after.status).toBe(404);
    expectStandardError(after.body as ErrorBody, "PROJECT_NOT_FOUND");

    const list = await get(owner);
    expect(list.body.data.projects).toEqual([]);
  });

  it("returns 404 on a second delete of the same project", async () => {
    const created = await createViaApi(owner);

    await del(owner, created._id);
    const res = await del(owner, created._id);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
  });

  it("returns 404 PROJECT_NOT_FOUND for a nonexistent ID", async () => {
    const res = await del(owner, objectId());

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
  });
});

describe("validation failures", () => {
  const without = (field: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...validBody };
    delete copy[field];
    return copy;
  };

  const invalidCreates: [string, Record<string, unknown>][] = [
    ["missing name", without("name")],
    ["missing slug", without("slug")],
    ["missing status", without("status")],
    ["whitespace-only name", { ...validBody, name: "   " }],
    ["whitespace-only slug", { ...validBody, slug: "   " }],
    ["whitespace-only status", { ...validBody, status: "   " }],
    ["slug with spaces", { ...validBody, slug: "has space" }],
    ["slug with underscore", { ...validBody, slug: "has_underscore" }],
    ["slug with leading hyphen", { ...validBody, slug: "-lead" }],
    ["slug with double hyphen", { ...validBody, slug: "a--b" }],
    [
      "description over 500 characters",
      { ...validBody, description: "d".repeat(501) },
    ],
    ["name over 150 characters", { ...validBody, name: "n".repeat(151) }],
    ["slug over 150 characters", { ...validBody, slug: "s".repeat(151) }],
    [
      "status over 50 characters",
      { ...validBody, status: "S".repeat(51) },
    ],
    ["non-string name", { ...validBody, name: 123 }],
    ["protected field organizationId", { ...validBody, organizationId: objectId() }],
    ["protected field createdBy", { ...validBody, createdBy: objectId() }],
    ["unknown field", { ...validBody, extra: true }],
  ];

  it.each(invalidCreates)(
    "POST rejects %s with 400 VALIDATION_ERROR",
    async (_label, body) => {
      const res = await post(owner, body);

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(await Project.countDocuments({})).toBe(0);
    },
  );

  it("accepts values exactly at the maximum lengths", async () => {
    const res = await post(owner, {
      name: "n".repeat(150),
      description: "d".repeat(500),
      slug: "s".repeat(150),
      status: "S".repeat(50),
    });

    expect(res.status).toBe(201);
  });

  const invalidUpdates: [string, Record<string, unknown>][] = [
    ["an empty body", {}],
    ["a whitespace-only name", { name: "  " }],
    ["an invalid slug", { slug: "Bad Slug!" }],
    ["a description over 500 characters", { description: "d".repeat(501) }],
    ["a name over 150 characters", { name: "n".repeat(151) }],
    ["a protected field", { createdAt: "2000-01-01T00:00:00.000Z" }],
    ["an unknown field", { extra: true }],
  ];

  it.each(invalidUpdates)(
    "PATCH rejects %s with 400 VALIDATION_ERROR",
    async (_label, body) => {
      const created = await createViaApi(owner);

      const res = await patch(owner, created._id, body);

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");

      const stored = await Project.findById(created._id).lean();
      expect(stored?.name).toBe(validBody.name);
      expect(stored?.slug).toBe(validBody.slug);
    },
  );
});

describe("slug uniqueness", () => {
  it("does not create a second project with the same slug in one organization", async () => {
    await Project.init();
    await createViaApi(owner, { slug: "dup" });

    const res = await post(owner, { ...validBody, slug: "dup" });

    expect(res.status).not.toBe(201);
    expect(
      await Project.countDocuments({
        organizationId: owner.user.organizationId,
        slug: "dup",
      }),
    ).toBe(1);
  });

  it("KNOWN GAP: the duplicate surfaces as a generic 500 until duplicate-key translation exists", async () => {
    await Project.init();
    await createViaApi(owner, { slug: "dup" });

    const res = await post(owner, { ...validBody, slug: "dup" });

    expect(res.status).toBe(500);
    expectStandardError(res.body as ErrorBody);
  });

  it("does not let an update collide with an existing slug in the organization", async () => {
    await Project.init();
    await createViaApi(owner, { slug: "taken" });
    const other = await createViaApi(owner, { slug: "other" });

    const res = await patch(owner, other._id, { slug: "taken" });

    expect(res.status).not.toBe(200);
    expect((await Project.findById(other._id).lean())?.slug).toBe(
      "other",
    );
  });

  it("allows the same slug in different organizations", async () => {
    const other = await createTenant();

    const a = await createViaApi(owner, { slug: "shared" });
    const b = await createViaApi(other, { slug: "shared" });

    expect(a.organizationId).toBe(owner.user.organizationId);
    expect(b.organizationId).toBe(other.user.organizationId);
    expect(a._id).not.toBe(b._id);
    expect(await Project.countDocuments({ slug: "shared" })).toBe(2);
  });
});

describe("authentication and authorization smoke", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const res = await request(app).post("/api/projects").send(validBody);

    expect(res.status).toBe(401);
    expectStandardError(res.body as ErrorBody);
    expect(await Project.countDocuments({})).toBe(0);
  });

  it("rejects a user without the required permission with 403", async () => {
    const viewer = await createTenant(
      [PERMISSIONS.PROJECT_READ],
      ROLE_NAMES.VIEWER,
    );

    const res = await post(viewer, validBody);

    expect(res.status).toBe(403);
    expectStandardError(res.body as ErrorBody, "FORBIDDEN");
    expect(await Project.countDocuments({})).toBe(0);

    // Read-only access still works for the same user.
    expect((await get(viewer)).status).toBe(200);
  });
});
