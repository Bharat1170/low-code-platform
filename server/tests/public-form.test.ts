import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { PUBLIC_RATE_LIMITS } from "../src/middleware/public-rate-limit.middleware.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { FormSubmission } from "../src/models/form-submission.model.js";
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
 * Share links: GET /api/public/forms/:publicId and
 * POST /api/public/forms/:publicId/submissions. No authentication.
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

const field = (overrides: Record<string, unknown>) => ({
  description: "",
  required: false,
  validation: {},
  conditionalLogic: null,
  ...overrides,
});

const nameField = (label = "Name") =>
  field({
    id: "name",
    type: "TEXT",
    label,
    required: true,
    config: { placeholder: "", defaultValue: "" },
    validation: { minLength: 2 },
  });
const emailField = field({
  id: "email",
  type: "EMAIL",
  label: "Email",
  config: { placeholder: "", defaultValue: "" },
});

const schemaOf = (...fields: unknown[]) => ({ version: 1, fields });

let counter = 0;

const createForm = async (tenant: Tenant): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Feedback",
      description: "Tell us what you think",
      slug: `public-form-${counter}`,
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

const publicIdOf = async (formId: string): Promise<string> => {
  const form = await Form.findById(formId).lean();
  expect(form?.publicId).toMatch(/^[A-Za-z0-9_-]{24}$/);
  return form!.publicId!;
};

const setup = async (schema: unknown = schemaOf(nameField(), emailField)) => {
  const tenant = await createTenant();
  const formId = await createForm(tenant);
  expect((await save(tenant, formId, schema)).status).toBe(200);
  expect((await publish(tenant, formId)).status).toBe(200);
  return { tenant, formId, publicId: await publicIdOf(formId) };
};

const getPublic = (publicId: string) => request(app).get(`/api/public/forms/${publicId}`);

const submitPublic = (publicId: string, body: unknown) =>
  request(app)
    .post(`/api/public/forms/${publicId}/submissions`)
    .send(body as object);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/public/forms/:publicId", () => {
  it("returns only what is needed to render the published version, without auth", async () => {
    const { tenant, formId, publicId } = await setup();

    const res = await getPublic(publicId);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const form = res.body.data.form;
    expect(Object.keys(form).sort()).toEqual(["description", "name", "schema", "version"]);
    expect(form.name).toBe("Feedback");
    expect(form.description).toBe("Tell us what you think");
    expect(form.version).toBe(1);
    expect(form.schema.fields.map((f: { id: string }) => f.id)).toEqual(["name", "email"]);

    const raw = JSON.stringify(res.body);
    for (const secret of [formId, tenant.user.organizationId, tenant.user.userId, tenant.projectId]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain("draftSchema");
  });

  it("keeps serving the published version while the draft changes, then the new one after republish", async () => {
    const { tenant, formId, publicId } = await setup();

    expect((await save(tenant, formId, schemaOf(nameField("Full name")))).status).toBe(200);

    const before = await getPublic(publicId);
    expect(before.body.data.form.version).toBe(1);
    expect(before.body.data.form.schema.fields[0].label).toBe("Name");
    expect(before.body.data.form.schema.fields).toHaveLength(2);

    expect((await publish(tenant, formId)).status).toBe(200);
    // The share link never changes between versions.
    expect(await publicIdOf(formId)).toBe(publicId);

    const after = await getPublic(publicId);
    expect(after.body.data.form.version).toBe(2);
    expect(after.body.data.form.schema.fields[0].label).toBe("Full name");
  });

  it("answers 404 for unknown, malformed, internal-id and archived forms", async () => {
    const { tenant, formId, publicId } = await setup();

    for (const id of ["A".repeat(24), "short", formId, "%24where"]) {
      const res = await getPublic(id);
      expect(res.status).toBe(404);
      expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    }

    expect(
      (
        await request(app)
          .patch(`/api/forms/${formId}`)
          .set("Authorization", auth(tenant))
          .send({ status: "ARCHIVED" })
      ).status,
    ).toBe(200);

    const archived = await getPublic(publicId);
    expect(archived.status).toBe(404);
    expectStandardError(archived.body as ErrorBody, "FORM_NOT_FOUND");
  });

  it("has no share link before the first publish", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, schemaOf(nameField()));

    const form = await Form.findById(formId).lean();
    expect(form?.publicId).toBeUndefined();
  });
});

describe("POST /api/public/forms/:publicId/submissions", () => {
  it("stores an anonymous submission against the exact published version", async () => {
    const { tenant, formId, publicId } = await setup();
    const form = await Form.findById(formId).lean();

    const res = await submitPublic(publicId, {
      data: { name: "Ada", email: "ada@example.com" },
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Your response has been submitted");
    expect(Object.keys(res.body.data.submission)).toEqual(["submittedAt"]);
    expect(JSON.stringify(res.body)).not.toContain(formId);

    const stored = await FormSubmission.find({ formId }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.organizationId.toString()).toBe(tenant.user.organizationId);
    expect(stored[0]?.formVersionId.toString()).toBe(form!.publishedVersionId!.toString());
    expect(stored[0]?.version).toBe(1);
    expect(stored[0]?.submittedBy).toBeNull();
    expect(stored[0]?.data).toEqual({ name: "Ada", email: "ada@example.com" });

    const audits = await AuditLog.find({ action: "FORM_SUBMITTED" }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBeNull();
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain("ada@example.com");
  });

  it("is listed for the owner as an anonymous submission", async () => {
    const { tenant, formId, publicId } = await setup();
    expect((await submitPublic(publicId, { data: { name: "Ada" } })).status).toBe(201);

    const list = await request(app)
      .get(`/api/forms/${formId}/submissions`)
      .set("Authorization", auth(tenant));

    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0].submittedBy).toBeNull();
    expect(list.body.data.items[0].submittedByName).toBeNull();

    const details = await request(app)
      .get(`/api/forms/${formId}/submissions/${list.body.data.items[0].id}`)
      .set("Authorization", auth(tenant));
    expect(details.status).toBe(200);
    expect(details.body.data.submission.submittedBy).toBeNull();
    expect(details.body.data.submission.data).toEqual({ name: "Ada" });
  });

  it("rejects any key besides data, including forged identifiers", async () => {
    const { publicId } = await setup();
    const other = await createTenant();

    for (const extra of [
      { organizationId: other.user.organizationId },
      { formId: objectId() },
      { formVersionId: objectId() },
      { submittedBy: other.user.userId },
      { version: 99 },
    ]) {
      const res = await submitPublic(publicId, { data: { name: "Ada" }, ...extra });
      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect(await FormSubmission.countDocuments()).toBe(0);
  });

  it("validates against the published schema like an authenticated submission", async () => {
    const { publicId } = await setup();

    const cases: [unknown, string][] = [
      [{}, "name"],
      [{ name: "A" }, "name"],
      [{ name: "Ada", email: "not-an-email" }, "email"],
      [{ name: "Ada", unknown: "x" }, "unknown"],
      [{ name: { $gt: "" } }, "name"],
      [{ name: true }, "name"],
    ];

    for (const [data, fieldId] of cases) {
      const res = await submitPublic(publicId, { data });
      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(Object.keys(res.body.error.fields).join(",")).toContain(fieldId);
    }

    expect(await FormSubmission.countDocuments()).toBe(0);
  });

  it("rejects prototype-polluting keys and oversized payloads", async () => {
    const { publicId } = await setup();

    const polluted = await request(app)
      .post(`/api/public/forms/${publicId}/submissions`)
      .set("Content-Type", "application/json")
      .send('{"data":{"name":"Ada","__proto__":{"admin":true}}}');
    expect(polluted.status).toBe(400);

    const huge = await submitPublic(publicId, { data: { name: "x".repeat(20_000) } });
    expect(huge.status).toBe(400);

    expect(await FormSubmission.countDocuments()).toBe(0);
  });

  it("answers 404 for unpublished, archived and unknown forms", async () => {
    const tenant = await createTenant();
    const draftOnly = await createForm(tenant);
    await save(tenant, draftOnly, schemaOf(nameField()));

    expect((await submitPublic("B".repeat(24), { data: { name: "Ada" } })).status).toBe(404);
    expect((await submitPublic(draftOnly, { data: { name: "Ada" } })).status).toBe(404);

    const { tenant: owner, formId, publicId } = await setup();
    await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(owner))
      .send({ status: "ARCHIVED" });

    const archived = await submitPublic(publicId, { data: { name: "Ada" } });
    expect(archived.status).toBe(404);
    expectStandardError(archived.body as ErrorBody, "FORM_NOT_FOUND");
    expect(await FormSubmission.countDocuments()).toBe(0);
  });

  it("ignores an Authorization header (the submitter stays anonymous)", async () => {
    const { tenant, formId, publicId } = await setup();

    const res = await request(app)
      .post(`/api/public/forms/${publicId}/submissions`)
      .set("Authorization", auth(tenant))
      .send({ data: { name: "Ada" } });

    expect(res.status).toBe(201);
    const stored = await FormSubmission.findOne({ formId }).lean();
    expect(stored?.submittedBy).toBeNull();
  });

  it("rate limits repeated submissions per IP and form with 429", async () => {
    const { publicId } = await setup();

    for (let i = 0; i < PUBLIC_RATE_LIMITS.SUBMISSIONS_PER_IP_AND_FORM; i += 1) {
      expect((await submitPublic(publicId, { data: { name: "Ada" } })).status).toBe(201);
    }

    const limited = await submitPublic(publicId, { data: { name: "Ada" } });
    expect(limited.status).toBe(429);
    expectStandardError(limited.body as ErrorBody, "RATE_LIMIT_EXCEEDED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(await FormSubmission.countDocuments()).toBe(
      PUBLIC_RATE_LIMITS.SUBMISSIONS_PER_IP_AND_FORM,
    );
  });

  it("fails closed (503) when Redis is unavailable", async () => {
    const { publicId } = await setup();
    vi.spyOn(redisClient, "incr").mockRejectedValue(new Error("redis down"));

    const res = await submitPublic(publicId, { data: { name: "Ada" } });

    expect(res.status).toBe(503);
    expectStandardError(res.body as ErrorBody, "SERVICE_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain("redis down");
    expect(await FormSubmission.countDocuments()).toBe(0);
  });

  it("does not open the authenticated submissions API to anonymous callers", async () => {
    const { formId } = await setup();

    const res = await request(app)
      .post(`/api/forms/${formId}/submissions`)
      .send({ data: { name: "Ada" } });
    expect(res.status).toBe(401);

    const read = await request(app).get(`/api/forms/${formId}/submissions`);
    expect(read.status).toBe(401);
  });

  it("is still covered by tenant scoping for the owner's reads", async () => {
    const { formId, publicId } = await setup();
    await submitPublic(publicId, { data: { name: "Ada" } });
    const intruder = await createTenant([PERMISSIONS.SUBMISSION_READ]);

    const res = await request(app)
      .get(`/api/forms/${formId}/submissions`)
      .set("Authorization", auth(intruder));
    expect(res.status).toBe(404);
  });
});
