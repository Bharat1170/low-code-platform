import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { FormSubmission } from "../src/models/form-submission.model.js";
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
 * 8.17.16 — GET /api/forms/:id/submissions and
 *           GET /api/forms/:id/submissions/:submissionId.
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

const textField = (id: string, label: string) => ({
  id,
  type: "TEXT",
  label,
  description: "",
  required: false,
  config: { placeholder: "", defaultValue: "" },
  validation: {},
  conditionalLogic: null,
});

const schemaOf = (...fields: unknown[]) => ({ version: 1, fields });

let counter = 0;

const createForm = async (tenant: Tenant): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact",
      slug: `read-form-${counter}`,
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

const submit = (tenant: Tenant, formId: string, data: unknown) =>
  request(app)
    .post(`/api/forms/${formId}/submissions`)
    .set("Authorization", auth(tenant))
    .send({ data });

const list = (tenant: Tenant, formId: string, query = "") =>
  request(app)
    .get(`/api/forms/${formId}/submissions${query}`)
    .set("Authorization", auth(tenant));

const details = (tenant: Tenant, formId: string, submissionId: string) =>
  request(app)
    .get(`/api/forms/${formId}/submissions/${submissionId}`)
    .set("Authorization", auth(tenant));

const setup = async () => {
  const tenant = await createTenant();
  const formId = await createForm(tenant);
  await save(tenant, formId, schemaOf(textField("name", "Customer Name")));
  expect((await publish(tenant, formId)).status).toBe(200);
  return { tenant, formId };
};

/* Inserts submissions directly so their dates and versions are controlled. */
const seed = async (
  tenant: Tenant,
  formId: string,
  entries: { at: string; version?: number; name?: string }[],
) => {
  const ids: string[] = [];
  for (const entry of entries) {
    const created = await FormSubmission.create({
      organizationId: tenant.user.organizationId,
      formId,
      formVersionId: objectId(),
      version: entry.version ?? 1,
      data: { name: entry.name ?? "x" },
      submittedBy: tenant.user.userId,
      submittedAt: new Date(entry.at),
    });
    ids.push(created._id.toString());
  }
  return ids;
};

const expectValidation = (res: request.Response) => {
  expect(res.status).toBe(400);
  expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authentication and authorization", () => {
  it("returns 401 when unauthenticated (list and details)", async () => {
    const { formId } = await setup();

    expect((await request(app).get(`/api/forms/${formId}/submissions`)).status).toBe(401);
    expect(
      (await request(app).get(`/api/forms/${formId}/submissions/${objectId()}`)).status,
    ).toBe(401);
  });

  it("returns 403 without submission.read (list and details)", async () => {
    const { formId } = await setup();
    const limited = await createTenant(
      OWNER_PERMISSIONS.filter((p) => p !== PERMISSIONS.SUBMISSION_READ),
    );

    const a = await list(limited, formId);
    const b = await details(limited, formId, objectId());

    for (const res of [a, b]) {
      expect(res.status).toBe(403);
      expectStandardError(res.body as ErrorBody, "FORBIDDEN");
    }
  });

  it("does not let submission.create alone read submissions", async () => {
    const limited = await createTenant([PERMISSIONS.SUBMISSION_CREATE]);

    expect((await list(limited, objectId())).status).toBe(403);
  });
});

describe("listing", () => {
  it("returns an empty page for a form without submissions", async () => {
    const { tenant, formId } = await setup();

    const res = await list(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Submissions retrieved successfully");
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.pagination).toEqual({
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 0,
    });
  });

  it("lists a submission made through the API, with a minimal shape and no data", async () => {
    const { tenant, formId } = await setup();
    const made = await submit(tenant, formId, { name: "Secret Value" });
    expect(made.status).toBe(201);

    const res = await list(tenant, formId);

    expect(res.body.data.items).toHaveLength(1);
    const item = res.body.data.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "formId",
        "formVersionId",
        "id",
        "submittedAt",
        "submittedBy",
        "submittedByName",
        "version",
      ].sort(),
    );
    expect(item.id).toBe(made.body.data.submission.id);
    expect(item.submittedBy).toBe(tenant.user.userId);
    expect(typeof item.submittedByName).toBe("string");
    expect(JSON.stringify(res.body)).not.toContain("Secret Value");
    expect(JSON.stringify(res.body)).not.toContain("organizationId");
  });

  it("returns newest first by default, oldest first with order=asc", async () => {
    const { tenant, formId } = await setup();
    const [a, b, c] = await seed(tenant, formId, [
      { at: "2026-01-01T10:00:00Z" },
      { at: "2026-01-03T10:00:00Z" },
      { at: "2026-01-02T10:00:00Z" },
    ]);

    const desc = await list(tenant, formId);
    const asc = await list(tenant, formId, "?order=asc");

    expect(desc.body.data.items.map((i: { id: string }) => i.id)).toEqual([b, c, a]);
    expect(asc.body.data.items.map((i: { id: string }) => i.id)).toEqual([a, c, b]);
  });

  it("paginates, including a partial last page and a page beyond the total", async () => {
    const { tenant, formId } = await setup();
    await seed(
      tenant,
      formId,
      Array.from({ length: 5 }, (_, i) => ({ at: `2026-01-0${i + 1}T00:00:00Z` })),
    );

    const p1 = await list(tenant, formId, "?page=1&pageSize=2");
    const p2 = await list(tenant, formId, "?page=2&pageSize=2");
    const p3 = await list(tenant, formId, "?page=3&pageSize=2");
    const p9 = await list(tenant, formId, "?page=9&pageSize=2");

    expect(p1.body.data.items).toHaveLength(2);
    expect(p2.body.data.items).toHaveLength(2);
    expect(p3.body.data.items).toHaveLength(1);
    expect(p1.body.data.pagination).toEqual({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    const ids = [...p1.body.data.items, ...p2.body.data.items, ...p3.body.data.items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(ids).size).toBe(5);
    expect(p9.status).toBe(200);
    expect(p9.body.data.items).toEqual([]);
    expect(p9.body.data.pagination.total).toBe(5);
  });

  it("accepts pageSize 100 and rejects larger or invalid paging values", async () => {
    const { tenant, formId } = await setup();

    expect((await list(tenant, formId, "?pageSize=100")).status).toBe(200);
    for (const query of [
      "?pageSize=101",
      "?pageSize=0",
      "?pageSize=-1",
      "?pageSize=abc",
      "?pageSize=1.5",
      "?pageSize=999999999999",
      "?page=0",
      "?page=-2",
      "?page=x",
      "?page=10001",
      "?page=1&page=2",
    ]) {
      expectValidation(await list(tenant, formId, query));
    }
  });

  it("never lists more than the maximum page size", async () => {
    const { tenant, formId } = await setup();
    await seed(
      tenant,
      formId,
      Array.from({ length: 105 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      })),
    );

    const res = await list(tenant, formId, "?pageSize=100");

    expect(res.body.data.items).toHaveLength(100);
    expect(res.body.data.pagination.total).toBe(105);
    expect(res.body.data.pagination.totalPages).toBe(2);
  });
});

describe("filtering", () => {
  it("filters by version", async () => {
    const { tenant, formId } = await setup();
    await seed(tenant, formId, [
      { at: "2026-01-01T00:00:00Z", version: 1 },
      { at: "2026-01-02T00:00:00Z", version: 2 },
      { at: "2026-01-03T00:00:00Z", version: 2 },
    ]);

    const res = await list(tenant, formId, "?version=2");

    expect(res.body.data.items.map((i: { version: number }) => i.version)).toEqual([2, 2]);
    expect(res.body.data.pagination.total).toBe(2);
    expect((await list(tenant, formId, "?version=7")).body.data.items).toEqual([]);
  });

  it("filters by date range; a date-only submittedTo includes that whole day", async () => {
    const { tenant, formId } = await setup();
    await seed(tenant, formId, [
      { at: "2026-01-09T23:59:59Z" },
      { at: "2026-01-10T00:00:00Z" },
      { at: "2026-01-10T23:59:59Z" },
      { at: "2026-01-11T00:00:00Z" },
    ]);

    const day = await list(tenant, formId, "?submittedFrom=2026-01-10&submittedTo=2026-01-10");
    const from = await list(tenant, formId, "?submittedFrom=2026-01-10");
    const to = await list(tenant, formId, "?submittedTo=2026-01-09");
    const exact = await list(
      tenant,
      formId,
      "?submittedFrom=2026-01-10T00:00:00Z&submittedTo=2026-01-10T00:00:00Z",
    );

    expect(day.body.data.pagination.total).toBe(2);
    expect(from.body.data.pagination.total).toBe(3);
    expect(to.body.data.pagination.total).toBe(1);
    expect(exact.body.data.pagination.total).toBe(1);
  });

  it("combines version and date filters", async () => {
    const { tenant, formId } = await setup();
    await seed(tenant, formId, [
      { at: "2026-01-10T00:00:00Z", version: 1 },
      { at: "2026-01-10T00:00:00Z", version: 2 },
    ]);

    const res = await list(tenant, formId, "?version=2&submittedFrom=2026-01-10");

    expect(res.body.data.pagination.total).toBe(1);
  });

  it("rejects invalid versions and dates, and from after to", async () => {
    const { tenant, formId } = await setup();

    for (const query of [
      "?version=0",
      "?version=abc",
      "?version=1.5",
      "?submittedFrom=yesterday",
      "?submittedFrom=2026-02-31",
      "?submittedFrom=2026-13-01",
      "?submittedTo=2026-01-01 10:00",
      "?submittedFrom=2026-01-02&submittedTo=2026-01-01",
      "?order=sideways",
    ]) {
      expectValidation(await list(tenant, formId, query));
    }
  });
});

describe("query injection", () => {
  it.each([
    "?$where=1",
    "?%24where=sleep(1000)",
    "?page[$gt]=1",
    "?version[$ne]=1",
    "?version[$gt]=0",
    "?submittedFrom[$gt]=2020-01-01",
    "?sort=-submittedAt",
    "?sort=data.name",
    "?sort[$natural]=1",
    "?order[$ne]=asc",
    "?data.name=x",
    "?organizationId=" + "a".repeat(24),
    "?formId=" + "a".repeat(24),
    "?submittedBy=" + "a".repeat(24),
    "?__proto__[polluted]=1",
    "?constructor[prototype][polluted]=1",
    "?pageSize=10&limit=1000000",
  ])("rejects %s", async (query) => {
    const { tenant, formId } = await setup();

    const res = await list(tenant, formId, query);

    expectValidation(res);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not let a body or header choose the tenant", async () => {
    const a = await setup();
    const b = await setup();
    await seed(b.tenant, b.formId, [{ at: "2026-01-01T00:00:00Z" }]);

    const res = await request(app)
      .get(`/api/forms/${b.formId}/submissions`)
      .set("Authorization", auth(a.tenant))
      .set("X-Organization-Id", b.tenant.user.organizationId)
      .send({ organizationId: b.tenant.user.organizationId });

    expect(res.status).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("lets a tenant read its own list and details", async () => {
    const { tenant, formId } = await setup();
    const made = await submit(tenant, formId, { name: "Ada" });

    expect((await list(tenant, formId)).status).toBe(200);
    expect((await details(tenant, formId, made.body.data.submission.id)).status).toBe(200);
  });

  it("returns 404 for another tenant's form (list and details) without leaking data", async () => {
    const a = await setup();
    const b = await setup();
    const made = await submit(b.tenant, b.formId, { name: "B private" });
    const submissionB = made.body.data.submission.id as string;

    const listRes = await list(a.tenant, b.formId);
    const detailRes = await details(a.tenant, b.formId, submissionB);

    for (const res of [listRes, detailRes]) {
      expect(res.status).toBe(404);
      expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toContain("B private");
    }
  });

  it("returns 404 for another tenant's submission id under the caller's own form", async () => {
    const a = await setup();
    const b = await setup();
    const made = await submit(b.tenant, b.formId, { name: "B private" });

    const res = await details(a.tenant, a.formId, made.body.data.submission.id);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "SUBMISSION_NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toContain("B private");
  });

  it("returns 404 for a valid submission id under a different form of the same tenant", async () => {
    const { tenant, formId } = await setup();
    const other = await createForm(tenant);
    const made = await submit(tenant, formId, { name: "x" });

    const res = await details(tenant, other, made.body.data.submission.id);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "SUBMISSION_NOT_FOUND");
  });

  it("does not list another form's submissions", async () => {
    const { tenant, formId } = await setup();
    const other = await createForm(tenant);
    await submit(tenant, formId, { name: "x" });

    expect((await list(tenant, other)).body.data.items).toEqual([]);
  });

  it("returns 404 for random and 400 for malformed ids", async () => {
    const { tenant, formId } = await setup();

    const missing = await details(tenant, formId, objectId());
    expect(missing.status).toBe(404);
    expectStandardError(missing.body as ErrorBody, "SUBMISSION_NOT_FOUND");
    expect((await details(tenant, formId, "not-an-id")).status).toBe(400);
    expect((await details(tenant, "not-an-id", objectId())).status).toBe(400);
    expect((await list(tenant, objectId())).status).toBe(404);
    expect((await list(tenant, "not-an-id")).status).toBe(400);
  });

  it("scopes every repository query by organization and form", async () => {
    const { tenant, formId } = await setup();
    const made = await submit(tenant, formId, { name: "x" });
    const find = vi.spyOn(FormSubmission, "find");
    const count = vi.spyOn(FormSubmission, "countDocuments");
    const findOne = vi.spyOn(FormSubmission, "findOne");

    await list(tenant, formId, "?version=1");
    await details(tenant, formId, made.body.data.submission.id);

    for (const call of [find.mock.calls[0], count.mock.calls[0], findOne.mock.calls[0]]) {
      const filter = call[0] as Record<string, { toString(): string }>;
      expect(filter.organizationId.toString()).toBe(tenant.user.organizationId);
      expect(filter.formId.toString()).toBe(formId);
    }
    const byId = findOne.mock.calls[0][0] as { _id: { toString(): string } };
    expect(byId._id.toString()).toBe(made.body.data.submission.id);
  });
});

describe("details", () => {
  it("returns the submission with a safe shape", async () => {
    const { tenant, formId } = await setup();
    const made = await submit(tenant, formId, { name: "Bharat" });

    const res = await details(tenant, formId, made.body.data.submission.id);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Submission retrieved successfully");
    const sub = res.body.data.submission;
    expect(Object.keys(sub).sort()).toEqual(
      [
        "data",
        "formId",
        "formName",
        "formVersionId",
        "id",
        "schema",
        "submittedAt",
        "submittedBy",
        "submittedByName",
        "version",
      ].sort(),
    );
    expect(sub.data).toEqual({ name: "Bharat" });
    expect(sub.formName).toBe("Contact");
    expect(sub.schema.fields[0].label).toBe("Customer Name");
    const text = JSON.stringify(res.body);
    for (const leaked of ["organizationId", "__v", "createdAt", "updatedAt", "_id"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("returns HTML-looking data unchanged as JSON text", async () => {
    const { tenant, formId } = await setup();
    const xss = "<script>alert(1)</script>";
    const made = await submit(tenant, formId, { name: xss });

    const res = await details(tenant, formId, made.body.data.submission.id);

    expect(res.body.data.submission.data.name).toBe(xss);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("version-aware details", () => {
  it("interprets a submission with the version it was made against, not the current one", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);

    await save(tenant, formId, schemaOf(textField("name", "Customer Name"), textField("nick", "Nickname")));
    const v1 = await publish(tenant, formId);
    const first = await submit(tenant, formId, { name: "Bharat", nick: "B" });

    // Version 2: label renamed and "nick" removed.
    await save(tenant, formId, schemaOf(textField("name", "Full Name")));
    const v2 = await publish(tenant, formId);
    const second = await submit(tenant, formId, { name: "Ada" });

    const old = await details(tenant, formId, first.body.data.submission.id);
    const current = await details(tenant, formId, second.body.data.submission.id);

    expect(old.status).toBe(200);
    expect(old.body.data.submission.version).toBe(1);
    expect(old.body.data.submission.formVersionId).toBe(v1.body.data.versionId);
    expect(old.body.data.submission.schema.fields.map((f: { label: string }) => f.label)).toEqual([
      "Customer Name",
      "Nickname",
    ]);
    // The removed field's value is still there and still described.
    expect(old.body.data.submission.data).toEqual({ name: "Bharat", nick: "B" });

    expect(current.body.data.submission.formVersionId).toBe(v2.body.data.versionId);
    expect(current.body.data.submission.schema.fields[0].label).toBe("Full Name");
  });

  it("returns schema null, not an error, if the version document is missing", async () => {
    const { tenant, formId } = await setup();
    const [id] = await seed(tenant, formId, [{ at: "2026-01-01T00:00:00Z" }]);

    const res = await details(tenant, formId, id);

    expect(res.status).toBe(200);
    expect(res.body.data.submission.schema).toBeNull();
    expect(res.body.data.submission.data).toEqual({ name: "x" });
  });
});

describe("side effects", () => {
  it("does not audit reads or touch the published-form cache", async () => {
    const { tenant, formId } = await setup();
    const made = await submit(tenant, formId, { name: "x" });
    const audits = await AuditLog.countDocuments({});
    const spies = [
      vi.spyOn(redisClient, "get"),
      vi.spyOn(redisClient, "set"),
      vi.spyOn(redisClient, "del"),
    ];

    await list(tenant, formId);
    await details(tenant, formId, made.body.data.submission.id);

    expect(await AuditLog.countDocuments({})).toBe(audits);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
