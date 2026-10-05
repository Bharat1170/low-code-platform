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
  expectNoInternals,
  expectStandardError,
  resetRateLimits,
  signAccessToken,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.16.7 — Project tenant-isolation and security tests, over the real
 * /api/projects routes.
 */

interface Tenant {
  user: TestUser;
  session: TestSession;
}

const tenantWithPermissions = async (
  permissions: readonly string[],
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

const createOwner = (): Promise<Tenant> =>
  tenantWithPermissions(OWNER_PERMISSIONS);

const auth = (tenant: Tenant): string =>
  bearer(tenant.session.accessToken);

const validBody = (slug: string) => ({
  name: `Project ${slug}`,
  slug,
  status: "active",
});

/* Seeds a project straight into the DB (not via the API). */
const seedProject = async (tenant: Tenant, slug: string) => {
  return Project.create({
    organizationId: tenant.user.organizationId,
    createdBy: tenant.user.userId,
    name: `Project ${slug}`,
    description: "original",
    slug,
    status: "ACTIVE",
  });
};

beforeEach(async () => {
  await resetRateLimits();
});

describe("cross-tenant access by project ID", () => {
  it("GET returns 404 PROJECT_NOT_FOUND and no data", async () => {
    const a = await createOwner();
    const b = await createOwner();
    const project = await seedProject(a, "secret-a");

    const res = await request(app)
      .get(`/api/projects/${project._id}`)
      .set("Authorization", auth(b));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toContain("secret-a");
    expect(JSON.stringify(res.body)).not.toContain(
      a.user.organizationId,
    );
  });

  it("PATCH returns 404 and leaves the project unchanged", async () => {
    const a = await createOwner();
    const b = await createOwner();
    const project = await seedProject(a, "secret-a");

    const res = await request(app)
      .patch(`/api/projects/${project._id}`)
      .set("Authorization", auth(b))
      .send({ name: "Hijacked", status: "deleted" });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");

    const after = await Project.findById(project._id).lean();
    expect(after?.name).toBe("Project secret-a");
    expect(after?.status).toBe("ACTIVE");
    expect(after?.organizationId.toString()).toBe(
      a.user.organizationId,
    );
  });

  it("DELETE returns 404 and the project still exists", async () => {
    const a = await createOwner();
    const b = await createOwner();
    const project = await seedProject(a, "secret-a");

    const res = await request(app)
      .delete(`/api/projects/${project._id}`)
      .set("Authorization", auth(b));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
    expect(await Project.countDocuments({ _id: project._id })).toBe(1);
  });

  it("returns the same 404 for a nonexistent ID as for a foreign one", async () => {
    const a = await createOwner();
    const b = await createOwner();
    const project = await seedProject(a, "secret-a");

    const foreign = await request(app)
      .get(`/api/projects/${project._id}`)
      .set("Authorization", auth(b));
    const missing = await request(app)
      .get(`/api/projects/${objectId()}`)
      .set("Authorization", auth(b));

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });
});

describe("list isolation", () => {
  it("returns only the authenticated organization's projects", async () => {
    const a = await createOwner();
    const b = await createOwner();
    await seedProject(a, "a-one");
    await seedProject(a, "a-two");
    await seedProject(b, "b-one");

    const resA = await request(app)
      .get("/api/projects")
      .set("Authorization", auth(a));
    const resB = await request(app)
      .get("/api/projects")
      .set("Authorization", auth(b));

    const slugs = (res: request.Response): string[] =>
      (res.body.data.projects as { slug: string }[])
        .map((p) => p.slug)
        .sort();

    expect(resA.status).toBe(200);
    expect(slugs(resA)).toEqual(["a-one", "a-two"]);
    expect(resB.status).toBe(200);
    expect(slugs(resB)).toEqual(["b-one"]);
  });
});

describe("organizationId can never come from the client", () => {
  it("POST with organizationId is rejected and nothing is created", async () => {
    const a = await createOwner();
    const b = await createOwner();

    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send({
        ...validBody("inject"),
        organizationId: b.user.organizationId,
      });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await Project.countDocuments({})).toBe(0);
  });

  it("PATCH with organizationId is rejected and organizationId is unchanged", async () => {
    const a = await createOwner();
    const b = await createOwner();
    const project = await seedProject(a, "keep");

    const res = await request(app)
      .patch(`/api/projects/${project._id}`)
      .set("Authorization", auth(a))
      .send({ name: "New", organizationId: b.user.organizationId });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");

    const after = await Project.findById(project._id).lean();
    expect(after?.organizationId.toString()).toBe(
      a.user.organizationId,
    );
    expect(after?.name).toBe("Project keep");
  });

  it("GET list with organizationId in the query is rejected", async () => {
    const a = await createOwner();
    const b = await createOwner();
    await seedProject(b, "b-only");

    const res = await request(app)
      .get(`/api/projects?organizationId=${b.user.organizationId}`)
      .set("Authorization", auth(a));

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("b-only");
  });

  it("organization headers have no tenant-selection effect", async () => {
    const a = await createOwner();
    const b = await createOwner();
    await seedProject(b, "b-only");

    const list = await request(app)
      .get("/api/projects")
      .set("Authorization", auth(a))
      .set("X-Organization-Id", b.user.organizationId)
      .set("organizationId", b.user.organizationId);

    expect(list.status).toBe(200);
    expect(list.body.data.projects).toEqual([]);

    const created = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .set("X-Organization-Id", b.user.organizationId)
      .set("organizationId", b.user.organizationId)
      .send(validBody("header"));

    expect(created.status).toBe(201);
    expect(created.body.data.project.organizationId).toBe(
      a.user.organizationId,
    );
    expect(
      await Project.countDocuments({
        organizationId: b.user.organizationId,
        slug: "header",
      }),
    ).toBe(0);
  });

  it("a created project is always owned by the authenticated organization and user", async () => {
    const a = await createOwner();
    const b = await createOwner();

    const res = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send(validBody("mine"));

    expect(res.status).toBe(201);

    const stored = await Project.findOne({ slug: "mine" }).lean();
    expect(stored?.organizationId.toString()).toBe(a.user.organizationId);
    expect(stored?.createdBy.toString()).toBe(a.user.userId);
    expect(
      await Project.countDocuments({
        organizationId: b.user.organizationId,
      }),
    ).toBe(0);
  });
});

describe("protected and unknown fields", () => {
  const protectedFields: Record<string, unknown> = {
    _id: objectId(),
    createdBy: objectId(),
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    organizationId: objectId(),
    unknownField: "x",
  };

  for (const [field, value] of Object.entries(protectedFields)) {
    it(`POST rejects ${field}`, async () => {
      const a = await createOwner();

      const res = await request(app)
        .post("/api/projects")
        .set("Authorization", auth(a))
        .send({ ...validBody("p"), [field]: value });

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(await Project.countDocuments({})).toBe(0);
    });

    it(`PATCH rejects ${field}`, async () => {
      const a = await createOwner();
      const project = await seedProject(a, "p");

      const res = await request(app)
        .patch(`/api/projects/${project._id}`)
        .set("Authorization", auth(a))
        .send({ name: "Changed", [field]: value });

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");

      const after = await Project.findById(project._id).lean();
      expect(after?.name).toBe("Project p");
      expect(after?._id.toString()).toBe(project._id.toString());
      expect(after?.createdBy.toString()).toBe(a.user.userId);
    });
  }

  it("PATCH rejects an empty body", async () => {
    const a = await createOwner();
    const project = await seedProject(a, "p");

    const res = await request(app)
      .patch(`/api/projects/${project._id}`)
      .set("Authorization", auth(a))
      .send({});

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  });
});

describe("authentication", () => {
  const calls = (
    id: string,
  ): [string, () => request.Test][] => [
    ["GET /", () => request(app).get("/api/projects")],
    [
      "POST /",
      () => request(app).post("/api/projects").send(validBody("x")),
    ],
    ["GET /:id", () => request(app).get(`/api/projects/${id}`)],
    [
      "PATCH /:id",
      () =>
        request(app).patch(`/api/projects/${id}`).send({ name: "x" }),
    ],
    ["DELETE /:id", () => request(app).delete(`/api/projects/${id}`)],
  ];

  it("rejects requests without an access token with 401", async () => {
    const a = await createOwner();
    const project = await seedProject(a, "p");

    for (const [label, call] of calls(project._id.toString())) {
      const res = await call();
      expect(res.status, label).toBe(401);
      expectStandardError(res.body as ErrorBody);
    }

    expect(await Project.countDocuments({})).toBe(1);
  });

  it("rejects invalid and expired access tokens with 401", async () => {
    const a = await createOwner();
    const project = await seedProject(a, "p");

    const expired = signAccessToken(a.user, {
      claims: { sessionId: a.session.sessionId },
      options: { expiresIn: -60 },
    });
    const forged = signAccessToken(a.user, {
      claims: { sessionId: a.session.sessionId },
      secret: "x".repeat(40),
    });

    for (const token of ["garbage", expired, forged]) {
      for (const [label, call] of calls(project._id.toString())) {
        const res = await call().set("Authorization", bearer(token));
        expect(res.status, label).toBe(401);
        expectStandardError(res.body as ErrorBody);
      }
    }

    const after = await Project.findById(project._id).lean();
    expect(after?.name).toBe("Project p");
    expect(await Project.countDocuments({})).toBe(1);
  });
});

describe("permission enforcement", () => {
  const allProjectPermissions = [
    PERMISSIONS.PROJECT_CREATE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_UPDATE,
    PERMISSIONS.PROJECT_DELETE,
  ];

  const without = (missing: string) =>
    allProjectPermissions.filter((p) => p !== missing);

  it("returns 403 FORBIDDEN for each route lacking its permission", async () => {
    const readTenant = await tenantWithPermissions(
      without(PERMISSIONS.PROJECT_READ),
      ROLE_NAMES.BUILDER,
    );
    const createTenant = await tenantWithPermissions(
      without(PERMISSIONS.PROJECT_CREATE),
      ROLE_NAMES.BUILDER,
    );
    const updateTenant = await tenantWithPermissions(
      without(PERMISSIONS.PROJECT_UPDATE),
      ROLE_NAMES.BUILDER,
    );
    const deleteTenant = await tenantWithPermissions(
      without(PERMISSIONS.PROJECT_DELETE),
      ROLE_NAMES.BUILDER,
    );

    const ownProject = await seedProject(updateTenant, "p");
    const id = ownProject._id.toString();
    const otherId = (await seedProject(deleteTenant, "q"))._id.toString();
    const readId = (await seedProject(readTenant, "r"))._id.toString();

    const results = await Promise.all([
      request(app)
        .get("/api/projects")
        .set("Authorization", auth(readTenant)),
      request(app)
        .get(`/api/projects/${readId}`)
        .set("Authorization", auth(readTenant)),
      request(app)
        .post("/api/projects")
        .set("Authorization", auth(createTenant))
        .send(validBody("x")),
      request(app)
        .patch(`/api/projects/${id}`)
        .set("Authorization", auth(updateTenant))
        .send({ name: "Changed" }),
      request(app)
        .delete(`/api/projects/${otherId}`)
        .set("Authorization", auth(deleteTenant)),
    ]);

    for (const res of results) {
      expect(res.status).toBe(403);
      expectStandardError(res.body as ErrorBody, "FORBIDDEN");
    }

    expect(await Project.countDocuments({ slug: "x" })).toBe(0);
    expect((await Project.findById(id).lean())?.name).toBe("Project p");
    expect(await Project.countDocuments({ _id: otherId })).toBe(1);
  });

  it("returns 403 for a user with no roles", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(403);
    expectStandardError(res.body as ErrorBody, "FORBIDDEN");
  });

  it("does not let another organization's role grant access", async () => {
    const owner = await createOwner();
    const user = await createTestUser();
    // Role belongs to a different organization than the user.
    await User.updateOne(
      { _id: user.userId },
      {
        $set: {
          roleIds: (
            await Role.find({
              organizationId: owner.user.organizationId,
            })
          ).map((r) => r._id),
        },
      },
    );
    const session = await createTestSession(user);

    const res = await request(app)
      .get("/api/projects")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(403);
  });
});

describe("malformed project ID", () => {
  const badIds = ["not-an-id", "123", "z".repeat(24), "%24ne"];

  it("returns 400 VALIDATION_ERROR (not 500) for GET/PATCH/DELETE", async () => {
    const a = await createOwner();

    for (const id of badIds) {
      const responses = await Promise.all([
        request(app)
          .get(`/api/projects/${id}`)
          .set("Authorization", auth(a)),
        request(app)
          .patch(`/api/projects/${id}`)
          .set("Authorization", auth(a))
          .send({ name: "x" }),
        request(app)
          .delete(`/api/projects/${id}`)
          .set("Authorization", auth(a)),
      ]);

      for (const res of responses) {
        expect(res.status, id).toBe(400);
        expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
        expectNoInternals(res.body);
      }
    }
  });
});

describe("NoSQL operator and prototype-pollution input", () => {
  const raw = (body: string, tenant: Tenant) =>
    request(app)
      .post("/api/projects")
      .set("Authorization", auth(tenant))
      .set("Content-Type", "application/json")
      .send(body);

  it("POST rejects $where, __proto__ and operator objects", async () => {
    const a = await createOwner();

    const bodies = [
      '{"name":"n","slug":"s","status":"x","$where":"1==1"}',
      '{"name":"n","slug":"s","status":"x","__proto__":{"admin":true}}',
      '{"name":"n","slug":"s","status":"x","constructor":{"prototype":{"x":1}}}',
      '{"name":{"$gt":""},"slug":"s","status":"x"}',
      '{"name":"n","slug":{"$ne":null},"status":"x"}',
      '{"name":"n","slug":"s","status":{"$ne":"x"}}',
      '{"name":"n","slug":"s","status":"x","description":{"$gt":""}}',
      '{"name":"n","slug":"s","status":"x","organizationId":{"$ne":null}}',
    ];

    for (const body of bodies) {
      const res = await raw(body, a);
      expect(res.status, body).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect(await Project.countDocuments({})).toBe(0);
    expect(
      ({} as Record<string, unknown>).admin,
      "Object.prototype must stay clean",
    ).toBeUndefined();
  });

  it("PATCH rejects $where, __proto__ and operator objects", async () => {
    const a = await createOwner();
    const project = await seedProject(a, "p");

    const bodies = [
      '{"$where":"1==1"}',
      '{"__proto__":{"admin":true}}',
      '{"name":{"$set":{"organizationId":"x"}}}',
      '{"$set":{"organizationId":"x"}}',
    ];

    for (const body of bodies) {
      const res = await request(app)
        .patch(`/api/projects/${project._id}`)
        .set("Authorization", auth(a))
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status, body).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    const after = await Project.findById(project._id).lean();
    expect(after?.name).toBe("Project p");
    expect(after?.organizationId.toString()).toBe(a.user.organizationId);
  });

  it("list query rejects $where and operator objects", async () => {
    const a = await createOwner();

    for (const query of [
      "$where=1",
      "organizationId[$ne]=x",
      "limit[$gt]=1",
      "status=ACTIVE",
    ]) {
      const res = await request(app)
        .get(`/api/projects?${query}`)
        .set("Authorization", auth(a));

      expect(res.status, query).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }
  });
});

describe("slug uniqueness is scoped to the organization", () => {
  it("allows the same slug in two different organizations", async () => {
    const a = await createOwner();
    const b = await createOwner();

    const resA = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send(validBody("shared"));
    const resB = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(b))
      .send(validBody("shared"));

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(await Project.countDocuments({ slug: "shared" })).toBe(2);
  });

  it("does not create a second project with the same slug in one organization", async () => {
    const a = await createOwner();
    // Ensure the unique index exists before relying on it.
    await Project.init();

    const first = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send(validBody("dup"));
    const second = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send(validBody("dup"));

    expect(first.status).toBe(201);
    expect(second.status).not.toBe(201);
    expect(
      await Project.countDocuments({
        organizationId: a.user.organizationId,
        slug: "dup",
      }),
    ).toBe(1);
    expectNoInternals(second.body);
  });

  it("KNOWN GAP: duplicate slug currently surfaces as a generic 500, not a 409", async () => {
    const a = await createOwner();
    await Project.init();

    await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send(validBody("dup"));
    const second = await request(app)
      .post("/api/projects")
      .set("Authorization", auth(a))
      .send(validBody("dup"));

    // Documents today's behavior; update when duplicate-key translation
    // is added in a later step.
    expect(second.status).toBe(500);
    expectStandardError(second.body as ErrorBody);
  });
});
