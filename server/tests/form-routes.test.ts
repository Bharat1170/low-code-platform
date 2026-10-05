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
  signAccessToken,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.17.6 — Form routes + authorization, over the real /api/forms routes.
 * Roles are real Role documents of the user's own organization, built the
 * same way as in authorization.test.ts. No role matrix is defined here:
 * each test user simply holds the permissions the test needs.
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

/* A tenant holding exactly one permission. */
const only = (permission: Permission): Promise<Tenant> =>
  createTenant([permission], ROLE_NAMES.BUILDER);

/* A tenant holding every form permission except the given one. */
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
  slug: "contact-form",
  status: "DRAFT",
  projectId: tenant.projectId,
  ...overrides,
});

/* Seeds a form straight into the DB (not via the API). */
const seedForm = async (tenant: Tenant, slug = "contact-form") => {
  return Form.create({
    organizationId: tenant.user.organizationId,
    projectId: tenant.projectId,
    name: "Contact Form",
    slug,
    status: "DRAFT",
    createdBy: tenant.user.userId,
  });
};

interface RouteCase {
  label: string;
  permission: Permission;
  call: (id: string, slug: string) => request.Test;
  successStatus: number;
}

const routeCases = (tenant: Tenant): RouteCase[] => [
  {
    label: "POST /api/forms",
    permission: PERMISSIONS.FORM_CREATE,
    call: () =>
      request(app)
        .post("/api/forms")
        .send(validBody(tenant, { slug: "new-form" })),
    successStatus: 201,
  },
  {
    label: "GET /api/forms",
    permission: PERMISSIONS.FORM_READ,
    call: () => request(app).get("/api/forms"),
    successStatus: 200,
  },
  {
    label: "GET /api/forms/slug/:slug",
    permission: PERMISSIONS.FORM_READ,
    call: (_id, slug) => request(app).get(`/api/forms/slug/${slug}`),
    successStatus: 200,
  },
  {
    label: "GET /api/forms/:id",
    permission: PERMISSIONS.FORM_READ,
    call: (id) => request(app).get(`/api/forms/${id}`),
    successStatus: 200,
  },
  {
    label: "PATCH /api/forms/:id",
    permission: PERMISSIONS.FORM_UPDATE,
    call: (id) =>
      request(app).patch(`/api/forms/${id}`).send({ name: "Renamed" }),
    successStatus: 200,
  },
  {
    label: "DELETE /api/forms/:id",
    permission: PERMISSIONS.FORM_DELETE,
    call: (id) => request(app).delete(`/api/forms/${id}`),
    successStatus: 200,
  },
];

// Route labels and permissions are static, so they can drive it.each.
const LABELS = routeCases({
  user: {} as TestUser,
  session: {} as TestSession,
  projectId: "",
}).map((c) => [c.label, c.permission, c.successStatus] as const);

const caseFor = (tenant: Tenant, label: string): RouteCase => {
  const found = routeCases(tenant).find((c) => c.label === label);
  if (!found) throw new Error(`Unknown route case ${label}`);
  return found;
};

beforeAll(async () => {
  await Form.init();
});

beforeEach(async () => {
  await resetRateLimits();
});

describe("authentication", () => {
  it.each(LABELS)("%s requires authentication (401)", async (label) => {
    const owner = await createTenant();
    const form = await seedForm(owner);

    const res = await caseFor(owner, label).call(
      form._id.toString(),
      form.slug,
    );

    expect(res.status).toBe(401);
    expectStandardError(res.body as ErrorBody);
    // Nothing was created, changed or deleted.
    expect(await Form.countDocuments({})).toBe(1);
    expect((await Form.findById(form._id).lean())?.name).toBe(
      "Contact Form",
    );
  });

  it.each(LABELS)(
    "%s rejects invalid and expired JWTs (401)",
    async (label) => {
      const owner = await createTenant();
      const form = await seedForm(owner);

      const expired = signAccessToken(owner.user, {
        claims: { sessionId: owner.session.sessionId },
        options: { expiresIn: -60 },
      });
      const forged = signAccessToken(owner.user, {
        claims: { sessionId: owner.session.sessionId },
        secret: "x".repeat(40),
      });

      for (const token of ["garbage", expired, forged]) {
        const res = await caseFor(owner, label)
          .call(form._id.toString(), form.slug)
          .set("Authorization", bearer(token));

        expect(res.status).toBe(401);
        expectStandardError(res.body as ErrorBody);
      }

      expect(await Form.countDocuments({})).toBe(1);
    },
  );
});

describe("permission enforcement", () => {
  it.each(LABELS)(
    "%s returns 403 FORBIDDEN without its permission",
    async (label, permission) => {
      const owner = await createTenant();
      const form = await seedForm(owner);
      const tenant = await allBut(permission);

      const res = await caseFor(tenant, label)
        .call(form._id.toString(), form.slug)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(403);
      expectStandardError(res.body as ErrorBody, "FORBIDDEN");
    },
  );

  it.each(LABELS)(
    "%s returns 403 for a user with no roles",
    async (label) => {
      const owner = await createTenant();
      const form = await seedForm(owner);
      const user = await createTestUser();
      const session = await createTestSession(user);

      const res = await caseFor(owner, label)
        .call(form._id.toString(), form.slug)
        .set("Authorization", bearer(session.accessToken));

      expect(res.status).toBe(403);
      expectStandardError(res.body as ErrorBody, "FORBIDDEN");
    },
  );

  it.each(LABELS)(
    "%s does not accept a different form permission",
    async (label, permission) => {
      // Holding only an unrelated permission must not be enough.
      const unrelated =
        permission === PERMISSIONS.FORM_PUBLISH
          ? PERMISSIONS.FORM_READ
          : PERMISSIONS.FORM_PUBLISH;
      const tenant = await only(unrelated);
      const form = await seedForm(tenant);

      const res = await caseFor(tenant, label)
        .call(form._id.toString(), form.slug)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(403);
    },
  );

  it("changes nothing when a mutation is forbidden", async () => {
    const owner = await createTenant();
    const form = await seedForm(owner);
    const noUpdate = await allBut(PERMISSIONS.FORM_UPDATE);
    const noDelete = await allBut(PERMISSIONS.FORM_DELETE);
    const noCreate = await allBut(PERMISSIONS.FORM_CREATE);

    await request(app)
      .patch(`/api/forms/${form._id}`)
      .set("Authorization", auth(noUpdate))
      .send({ name: "Hijacked" });
    await request(app)
      .delete(`/api/forms/${form._id}`)
      .set("Authorization", auth(noDelete));
    await request(app)
      .post("/api/forms")
      .set("Authorization", auth(noCreate))
      .send(validBody(noCreate));

    expect(await Form.countDocuments({})).toBe(1);
    expect((await Form.findById(form._id).lean())?.name).toBe(
      "Contact Form",
    );
  });

  it("does not let another organization's role grant access", async () => {
    const owner = await createTenant();
    const user = await createTestUser();
    await User.updateOne(
      { _id: user.userId },
      {
        $set: {
          roleIds: (
            await Role.find({ organizationId: owner.user.organizationId })
          ).map((r) => r._id),
        },
      },
    );
    const session = await createTestSession(user);

    const res = await request(app)
      .get("/api/forms")
      .set("Authorization", bearer(session.accessToken));

    expect(res.status).toBe(403);
  });
});

describe("success with the required permission", () => {
  it.each(LABELS)(
    "%s succeeds holding only its permission",
    async (label, permission, successStatus) => {
      // Create the seed form with a separate full-permission user in the
      // same organization is not needed: the tenant under test owns it.
      const tenant = await only(permission);
      const form = await seedForm(tenant);

      const res = await caseFor(tenant, label)
        .call(form._id.toString(), form.slug)
        .set("Authorization", auth(tenant));

      expect(res.status).toBe(successStatus);
      expect(res.body.success).toBe(true);
    },
  );

  it("POST creates the form in the authenticated organization", async () => {
    const tenant = await only(PERMISSIONS.FORM_CREATE);

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", auth(tenant))
      .send(validBody(tenant));

    expect(res.status).toBe(201);
    expect(res.body.data.form).toMatchObject({
      organizationId: tenant.user.organizationId,
      createdBy: tenant.user.userId,
    });
  });
});

describe("active account enforcement", () => {
  it.each(["SUSPENDED", "DELETED"])(
    "rejects a %s user with 403 ACCOUNT_NOT_ACTIVE on every route",
    async (status) => {
      const owner = await createTenant();
      const form = await seedForm(owner);
      await User.updateOne({ _id: owner.user.userId }, { $set: { status } });

      for (const [label] of LABELS) {
        const res = await caseFor(owner, label)
          .call(form._id.toString(), form.slug)
          .set("Authorization", auth(owner));

        expect(res.status, label).toBe(403);
        expectStandardError(res.body as ErrorBody, "ACCOUNT_NOT_ACTIVE");
      }

      expect(await Form.countDocuments({})).toBe(1);
    },
  );

  it.each(["SUSPENDED", "DELETED"])(
    "rejects a %s organization with 403 ACCOUNT_NOT_ACTIVE",
    async (status) => {
      const owner = await createTenant();
      await Organization.updateOne(
        { _id: owner.user.organizationId },
        { $set: { status } },
      );

      const res = await request(app)
        .get("/api/forms")
        .set("Authorization", auth(owner));

      expect(res.status).toBe(403);
      expectStandardError(res.body as ErrorBody, "ACCOUNT_NOT_ACTIVE");
    },
  );

  it("takes effect immediately for an already-issued token", async () => {
    const owner = await createTenant();

    expect(
      (await request(app).get("/api/forms").set("Authorization", auth(owner)))
        .status,
    ).toBe(200);

    await User.updateOne(
      { _id: owner.user.userId },
      { $set: { status: "SUSPENDED" } },
    );

    expect(
      (await request(app).get("/api/forms").set("Authorization", auth(owner)))
        .status,
    ).toBe(403);
  });
});

describe("tenant isolation through the routes", () => {
  it("GET by another organization's form ID returns 404 FORM_NOT_FOUND", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const form = await seedForm(a, "secret-a");

    const res = await request(app)
      .get(`/api/forms/${form._id}`)
      .set("Authorization", auth(b));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toContain("secret-a");
  });

  it("GET by slug is tenant scoped", async () => {
    const a = await createTenant();
    const b = await createTenant();
    await seedForm(a, "secret-a");

    const res = await request(app)
      .get("/api/forms/slug/secret-a")
      .set("Authorization", auth(b));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
  });

  it("PATCH on another organization's form returns 404 and changes nothing", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const form = await seedForm(a);

    const res = await request(app)
      .patch(`/api/forms/${form._id}`)
      .set("Authorization", auth(b))
      .send({ name: "Hijacked", status: "ARCHIVED" });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");

    const stored = await Form.findById(form._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.status).toBe("DRAFT");
    expect(stored?.updatedBy).toBeUndefined();
  });

  it("DELETE on another organization's form returns 404 and deletes nothing", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const form = await seedForm(a);

    const res = await request(app)
      .delete(`/api/forms/${form._id}`)
      .set("Authorization", auth(b));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    expect(await Form.countDocuments({ _id: form._id })).toBe(1);
  });

  it("returns the same 404 for a foreign form as for a nonexistent one", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const form = await seedForm(a);

    const foreign = await request(app)
      .get(`/api/forms/${form._id}`)
      .set("Authorization", auth(b));
    const missing = await request(app)
      .get(`/api/forms/${objectId()}`)
      .set("Authorization", auth(b));

    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
  });

  it("list returns only the authenticated organization's forms", async () => {
    const a = await createTenant();
    const b = await createTenant();
    await seedForm(a, "a-form");
    await seedForm(b, "b-form");

    const res = await request(app)
      .get("/api/forms")
      .set("Authorization", auth(a));

    expect(
      (res.body.data.forms as { slug: string }[]).map((f) => f.slug),
    ).toEqual(["a-form"]);
  });

  it("POST with another organization's project returns 404 PROJECT_NOT_FOUND", async () => {
    const a = await createTenant();
    const b = await createTenant();

    const res = await request(app)
      .post("/api/forms")
      .set("Authorization", auth(a))
      .send(validBody(a, { projectId: b.projectId }));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "PROJECT_NOT_FOUND");
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("organizationId in the body cannot bypass tenant isolation", async () => {
    const a = await createTenant();
    const b = await createTenant();

    const post = await request(app)
      .post("/api/forms")
      .set("Authorization", auth(a))
      .send(validBody(a, { organizationId: b.user.organizationId }));

    expect(post.status).toBe(400);
    expectStandardError(post.body as ErrorBody, "VALIDATION_ERROR");

    const form = await seedForm(b);
    const patch = await request(app)
      .patch(`/api/forms/${form._id}`)
      .set("Authorization", auth(a))
      .send({ name: "x", organizationId: a.user.organizationId });

    expect(patch.status).toBe(400);
    expect(
      (await Form.findById(form._id).lean())?.organizationId.toString(),
    ).toBe(b.user.organizationId);
  });

  it("organizationId in the query is rejected", async () => {
    const a = await createTenant();
    const b = await createTenant();
    await seedForm(b, "b-form");

    const res = await request(app)
      .get(`/api/forms?organizationId=${b.user.organizationId}`)
      .set("Authorization", auth(a));

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("b-form");
  });

  it("X-Organization-Id cannot change the tenant context", async () => {
    const a = await createTenant();
    const b = await createTenant();
    await seedForm(b, "b-form");

    const list = await request(app)
      .get("/api/forms")
      .set("Authorization", auth(a))
      .set("X-Organization-Id", b.user.organizationId);
    const created = await request(app)
      .post("/api/forms")
      .set("Authorization", auth(a))
      .set("X-Organization-Id", b.user.organizationId)
      .send(validBody(a));

    expect(list.status).toBe(200);
    expect(list.body.data.forms).toEqual([]);
    expect(created.status).toBe(201);
    expect(created.body.data.form.organizationId).toBe(
      a.user.organizationId,
    );
  });
});

describe("route ordering and request handling", () => {
  it("GET /slug/:slug resolves the slug route, not /:id", async () => {
    const tenant = await createTenant();
    const form = await seedForm(tenant, "my-form");

    const res = await request(app)
      .get("/api/forms/slug/my-form")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.data.form._id).toBe(form._id.toString());
  });

  it("a missing slug returns FORM_NOT_FOUND (404), not a malformed-ID 400", async () => {
    const tenant = await createTenant();

    const res = await request(app)
      .get("/api/forms/slug/does-not-exist")
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
  });

  it("GET /:id still resolves by ID", async () => {
    const tenant = await createTenant();
    const form = await seedForm(tenant);

    const res = await request(app)
      .get(`/api/forms/${form._id}`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.body.data.form.slug).toBe("contact-form");
  });

  it.each(["not-an-id", "123", "z".repeat(24)])(
    "malformed ID %j returns 400 VALIDATION_ERROR on GET, PATCH and DELETE",
    async (id) => {
      const tenant = await createTenant();

      const responses = await Promise.all([
        request(app)
          .get(`/api/forms/${id}`)
          .set("Authorization", auth(tenant)),
        request(app)
          .patch(`/api/forms/${id}`)
          .set("Authorization", auth(tenant))
          .send({ name: "x" }),
        request(app)
          .delete(`/api/forms/${id}`)
          .set("Authorization", auth(tenant)),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(400);
        expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      }
    },
  );

  it("permission is checked before the ID or body is validated", async () => {
    const tenant = await only(PERMISSIONS.FORM_READ);

    const res = await request(app)
      .patch("/api/forms/not-an-id")
      .set("Authorization", auth(tenant))
      .send({});

    expect(res.status).toBe(403);
  });
});

describe("existing Project authorization is unaffected", () => {
  it("Project routes still require authentication and project permissions", async () => {
    const formOnly = await only(PERMISSIONS.FORM_READ);
    const projectOnly = await only(PERMISSIONS.PROJECT_READ);

    expect((await request(app).get("/api/projects")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/projects")
          .set("Authorization", auth(formOnly))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/api/projects")
          .set("Authorization", auth(projectOnly))
      ).status,
    ).toBe(200);
  });

  it("form permissions do not grant project access and vice versa", async () => {
    const projectOnly = await only(PERMISSIONS.PROJECT_READ);

    const res = await request(app)
      .get("/api/forms")
      .set("Authorization", auth(projectOnly));

    expect(res.status).toBe(403);
    expectStandardError(res.body as ErrorBody, "FORBIDDEN");
  });
});
