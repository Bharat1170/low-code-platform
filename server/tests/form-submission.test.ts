import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { FormSubmission } from "../src/models/form-submission.model.js";
import { FormVersion } from "../src/models/form-version.model.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { publishedFormCacheKey } from "../src/repositories/published-form-cache.repository.js";

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
 * 8.17.15 — POST /api/forms/:id/submissions.
 * Real routes, auth, permissions, service, repositories, MongoDB
 * transactions and Redis.
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

const nameField = field({
  id: "name",
  type: "TEXT",
  label: "Name",
  required: true,
  config: { placeholder: "", defaultValue: "" },
  validation: { minLength: 3, maxLength: 10 },
});
const emailField = field({
  id: "email",
  type: "EMAIL",
  label: "Email",
  required: true,
  config: { placeholder: "", defaultValue: "" },
});
const countryField = (values: string[] = ["india", "france"], required = true) =>
  field({
    id: "country",
    type: "DROPDOWN",
    label: "Country",
    required,
    config: {
      placeholder: "",
      options: values.map((value) => ({ label: value, value })),
      defaultValue: "",
    },
  });
const termsField = field({
  id: "terms",
  type: "CHECKBOX",
  label: "Terms",
  required: true,
  config: { defaultValue: false },
});
const ageField = field({
  id: "age",
  type: "TEXT",
  label: "Age",
  config: { placeholder: "", defaultValue: "" },
  validation: { min: 18, max: 65 },
});
const codeField = field({
  id: "code",
  type: "TEXT",
  label: "Code",
  config: { placeholder: "", defaultValue: "" },
  validation: { pattern: "^[A-Z]{3}$" },
});
const nickField = field({
  id: "nick",
  type: "TEXT",
  label: "Nickname",
  config: { placeholder: "", defaultValue: "" },
});

const schemaOf = (...fields: unknown[]) => ({ version: 1, fields });
const fullSchema = () =>
  schemaOf(nameField, emailField, countryField(), termsField, ageField, codeField, nickField);

const validData = {
  name: "Bharat",
  email: "user@example.com",
  country: "india",
  terms: true,
};

let counter = 0;

const createForm = async (tenant: Tenant): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact",
      slug: `submission-form-${counter}`,
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

const submit = (tenant: Tenant, formId: string, body: unknown) =>
  request(app)
    .post(`/api/forms/${formId}/submissions`)
    .set("Authorization", auth(tenant))
    .send(body as object);

const setup = async (schema: unknown = fullSchema()) => {
  const tenant = await createTenant();
  const formId = await createForm(tenant);
  expect((await save(tenant, formId, schema)).status).toBe(200);
  expect((await publish(tenant, formId)).status).toBe(200);
  return { tenant, formId };
};

const expectInvalid = (res: request.Response, fieldId: string, message?: RegExp) => {
  expect(res.status).toBe(400);
  expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  expect(Object.keys(res.body.error.fields)).toContain(fieldId);
  if (message) expect(res.body.error.fields[fieldId]).toMatch(message);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("successful submission", () => {
  it("stores the submission against the published version and returns a minimal body", async () => {
    const { tenant, formId } = await setup();
    const version = await FormVersion.findOne({ formId });

    const res = await submit(tenant, formId, { data: validData });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Form submitted successfully");
    const sub = res.body.data.submission;
    expect(Object.keys(sub).sort()).toEqual(
      ["formId", "formVersionId", "id", "submittedAt", "version"].sort(),
    );
    expect(sub.formId).toBe(formId);
    expect(sub.formVersionId).toBe(version!._id.toString());
    expect(sub.version).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain("user@example.com");

    const stored = await FormSubmission.findById(sub.id).lean();
    expect(stored?.organizationId.toString()).toBe(tenant.user.organizationId);
    expect(stored?.submittedBy.toString()).toBe(tenant.user.userId);
    expect(stored?.data).toEqual(validData);
    expect(stored?.submittedAt).toBeInstanceOf(Date);
  });

  it("accepts optional fields omitted, and valid optional values", async () => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, {
      data: { ...validData, age: "30", code: "ABC", nick: "" },
    });

    expect(res.status).toBe(201);
  });

  it("accepts an unchecked optional checkbox and an optional empty dropdown", async () => {
    const { tenant, formId } = await setup(
      schemaOf(
        countryField(["a"], false),
        field({ id: "opt", type: "CHECKBOX", label: "Opt", config: { defaultValue: false } }),
      ),
    );

    expect((await submit(tenant, formId, { data: {} })).status).toBe(201);
    expect((await submit(tenant, formId, { data: { country: "", opt: false } })).status).toBe(201);
  });

  it("allows many submissions of the same form by the same user", async () => {
    const { tenant, formId } = await setup();

    expect((await submit(tenant, formId, { data: validData })).status).toBe(201);
    expect((await submit(tenant, formId, { data: validData })).status).toBe(201);
    expect(await FormSubmission.countDocuments({ formId })).toBe(2);
  });

  it("stores HTML-looking text as inert text", async () => {
    const { tenant, formId } = await setup();
    const xss = "<script>alert(1)</script>";

    const res = await submit(tenant, formId, { data: { ...validData, nick: xss } });

    expect(res.status).toBe(201);
    expect((await FormSubmission.findById(res.body.data.submission.id).lean())?.data.nick).toBe(xss);
  });

  it("writes an audit event with identifiers only, and does not touch the published cache", async () => {
    const { tenant, formId } = await setup();
    const key = publishedFormCacheKey(tenant.user.organizationId, formId);
    await redisClient.set(key, JSON.stringify({ marker: true }));
    const del = vi.spyOn(redisClient, "del");

    const res = await submit(tenant, formId, { data: validData });

    const audit = await AuditLog.findOne({ action: "FORM_SUBMITTED" }).lean();
    expect(audit?.resourceType).toBe("FORM_SUBMISSION");
    expect(audit?.resourceId?.toString()).toBe(res.body.data.submission.id);
    expect(Object.keys(audit!.metadata).sort()).toEqual(
      ["formId", "formVersionId", "submissionId", "version"].sort(),
    );
    expect(JSON.stringify(audit)).not.toContain("user@example.com");
    expect(del).not.toHaveBeenCalled();
    expect(await redisClient.get(key)).toBe(JSON.stringify({ marker: true }));
  });

  it("rolls the submission back when the audit write fails", async () => {
    const { tenant, formId } = await setup();
    vi.spyOn(AuditLog.prototype, "save").mockRejectedValueOnce(new Error("audit down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await submit(tenant, formId, { data: validData });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("audit down");
    expect(await FormSubmission.countDocuments({})).toBe(0);
    expect((await submit(tenant, formId, { data: validData })).status).toBe(201);
  });
});

describe("required fields", () => {
  it.each([
    ["name", { email: "a@b.co", country: "india", terms: true }],
    ["email", { name: "Bharat", country: "india", terms: true }],
    ["country", { name: "Bharat", email: "a@b.co", terms: true }],
  ])("rejects a missing required %s", async (id, data) => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { data });

    expectInvalid(res, id, /required/);
    expect(await FormSubmission.countDocuments({})).toBe(0);
  });

  it("rejects a required checkbox that is false or missing", async () => {
    const { tenant, formId } = await setup();

    expectInvalid(await submit(tenant, formId, { data: { ...validData, terms: false } }), "terms", /checked/);
    const { terms: _omit, ...rest } = validData;
    expectInvalid(await submit(tenant, formId, { data: rest }), "terms");
  });

  it("treats a blank required text as missing", async () => {
    const { tenant, formId } = await setup();
    expectInvalid(await submit(tenant, formId, { data: { ...validData, name: "   " } }), "name", /required/);
  });
});

describe("rules", () => {
  it("enforces minLength and maxLength", async () => {
    const { tenant, formId } = await setup();

    expectInvalid(await submit(tenant, formId, { data: { ...validData, name: "ab" } }), "name", /at least 3/);
    expectInvalid(await submit(tenant, formId, { data: { ...validData, name: "abcdefghijk" } }), "name", /at most 10/);
  });

  it("enforces min, max and numeric input", async () => {
    const { tenant, formId } = await setup();

    expectInvalid(await submit(tenant, formId, { data: { ...validData, age: "17" } }), "age", /at least 18/);
    expectInvalid(await submit(tenant, formId, { data: { ...validData, age: "66" } }), "age", /at most 65/);
    expectInvalid(await submit(tenant, formId, { data: { ...validData, age: "abc" } }), "age", /number/);
    expect((await submit(tenant, formId, { data: { ...validData, age: "18" } })).status).toBe(201);
  });

  it("validates email format", async () => {
    const { tenant, formId } = await setup();

    expectInvalid(await submit(tenant, formId, { data: { ...validData, email: "nope" } }), "email", /valid email/);
    expectInvalid(await submit(tenant, formId, { data: { ...validData, email: "a b@c.com" } }), "email");
  });

  it("enforces a pattern", async () => {
    const { tenant, formId } = await setup();

    expectInvalid(await submit(tenant, formId, { data: { ...validData, code: "abc" } }), "code", /format/);
    expect((await submit(tenant, formId, { data: { ...validData, code: "ABC" } })).status).toBe(201);
  });

  it("ignores a stored pattern that does not compile instead of failing", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    const version = await FormVersion.create({
      organizationId: tenant.user.organizationId,
      formId,
      version: 1,
      status: "PUBLISHED",
      schemaSnapshot: schemaOf({ ...codeField, validation: { pattern: "([" } }),
      settings: {},
      createdBy: tenant.user.userId,
      publishedBy: tenant.user.userId,
      publishedAt: new Date(),
    });
    await Form.updateOne(
      { _id: formId },
      { $set: { publishedVersionId: version._id, status: "PUBLISHED" } },
    );

    const res = await submit(tenant, formId, { data: { code: "whatever" } });

    expect(res.status).toBe(201);
  });

  it("only accepts declared dropdown options", async () => {
    const { tenant, formId } = await setup();

    expectInvalid(await submit(tenant, formId, { data: { ...validData, country: "mars" } }), "country", /options/);
  });
});

describe("types are never coerced", () => {
  it.each([
    ["name", {}, 400],
    ["name", 5, 400],
    ["email", 123, 400],
    ["country", true, 400],
    ["terms", "true", 400],
    ["terms", 1, 400],
  ])("rejects %s = %j", async (id, value) => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { data: { ...validData, [id]: value } });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await FormSubmission.countDocuments({})).toBe(0);
  });

  it("rejects null, arrays and nested objects", async () => {
    const { tenant, formId } = await setup();

    for (const value of [null, ["a"], { a: 1 }]) {
      const res = await submit(tenant, formId, { data: { ...validData, nick: value } });
      expect(res.status).toBe(400);
    }
  });

  it("rejects data that is not an object, or is missing", async () => {
    const { tenant, formId } = await setup();

    for (const body of [{ data: "x" }, { data: [] }, { data: null }, {}]) {
      expect((await submit(tenant, formId, body)).status).toBe(400);
    }
  });
});

describe("unknown and protected fields", () => {
  it("rejects an unknown field id and stores nothing", async () => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { data: { ...validData, admin: true } });

    expectInvalid(res, "admin", /Unknown field/);
    expect(await FormSubmission.countDocuments({})).toBe(0);
  });

  it.each([
    "organizationId",
    "formId",
    "formVersionId",
    "version",
    "submittedBy",
    "submittedAt",
    "createdBy",
    "updatedBy",
  ])("rejects %s at the top level of the request", async (key) => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { data: validData, [key]: objectId() });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await FormSubmission.countDocuments({})).toBe(0);
  });

  it("does not let the client choose the organization or version via data", async () => {
    const { tenant, formId } = await setup();

    for (const key of ["organizationId", "formVersionId", "submittedBy"]) {
      expect((await submit(tenant, formId, { data: { ...validData, [key]: objectId() } })).status).toBe(400);
    }
  });
});

describe("hostile payloads", () => {
  it("rejects $-operators as keys and as values", async () => {
    const { tenant, formId } = await setup();

    expect((await submit(tenant, formId, { data: { $ne: "x" } })).status).toBe(400);
    expect((await submit(tenant, formId, { data: { ...validData, name: { $gt: "" } } })).status).toBe(400);
    expect((await submit(tenant, formId, { data: { "a.b": "x" } })).status).toBe(400);
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects the key %s", async (key) => {
    const { tenant, formId } = await setup();

    const res = await request(app)
      .post(`/api/forms/${formId}/submissions`)
      .set("Authorization", auth(tenant))
      .set("Content-Type", "application/json")
      .send(`{"data":{"${key}":"x"}}`);

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await FormSubmission.countDocuments({})).toBe(0);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("rejects too many fields", async () => {
    const { tenant, formId } = await setup();
    const data = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, "x"]));

    expect((await submit(tenant, formId, { data })).status).toBe(400);
  });

  it("rejects an over-long string value", async () => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { data: { ...validData, nick: "x".repeat(10_001) } });

    expect(res.status).toBe(400);
  });

  it("rejects a submission whose total size is too large (413)", async () => {
    const { tenant, formId } = await setup();
    const data = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`f${i}`, "x".repeat(5000)]),
    );

    const res = await submit(tenant, formId, { data });

    expect(res.status).toBe(413);
    expectStandardError(res.body as ErrorBody, "SUBMISSION_TOO_LARGE");
  });

  it("rejects a request body above the global limit (413)", async () => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { data: { nick: "x".repeat(1_100_000) } });

    expect(res.status).toBe(413);
  });
});

describe("form state", () => {
  it("returns 404 for a form that does not exist", async () => {
    const tenant = await createTenant();

    const res = await submit(tenant, objectId(), { data: {} });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
  });

  it("rejects a malformed form id with 400", async () => {
    const tenant = await createTenant();
    expect((await submit(tenant, "not-an-id", { data: {} })).status).toBe(400);
  });

  it("returns 404 FORM_NOT_PUBLISHED for an unpublished form", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, fullSchema());

    const res = await submit(tenant, formId, { data: validData });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_PUBLISHED");
    expect(await FormSubmission.countDocuments({})).toBe(0);
  });

  it("returns 404 FORM_NOT_PUBLISHED for an archived form", async () => {
    const { tenant, formId } = await setup();
    await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(tenant))
      .send({ status: "ARCHIVED" });

    const res = await submit(tenant, formId, { data: validData });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_PUBLISHED");
  });

  it("returns 404 when the published version document is missing", async () => {
    const { tenant, formId } = await setup();
    await Form.updateOne({ _id: formId }, { $set: { publishedVersionId: objectId() } });

    const res = await submit(tenant, formId, { data: validData });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_PUBLISHED");
  });

  it("never validates against the draft", async () => {
    const { tenant, formId } = await setup();
    await save(tenant, formId, schemaOf(field({
      id: "draftOnly",
      type: "TEXT",
      label: "Draft only",
      required: true,
      config: { placeholder: "", defaultValue: "" },
    })));

    const res = await submit(tenant, formId, { data: validData });

    expect(res.status).toBe(201);
    const stored = await FormSubmission.findById(res.body.data.submission.id).lean();
    expect(stored?.version).toBe(1);
    expectInvalid(await submit(tenant, formId, { data: { draftOnly: "x" } }), "draftOnly", /Unknown field/);
  });
});

describe("versioning", () => {
  it("keeps every submission linked to the exact version it was made against", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, schemaOf(nickField));
    const v1 = await publish(tenant, formId);
    const first = await submit(tenant, formId, { data: { nick: "one" } });

    await save(tenant, formId, schemaOf(nickField, ageField));
    const v2 = await publish(tenant, formId);
    const second = await submit(tenant, formId, { data: { nick: "two", age: "30" } });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.submission.version).toBe(1);
    expect(first.body.data.submission.formVersionId).toBe(v1.body.data.versionId);
    expect(second.body.data.submission.version).toBe(2);
    expect(second.body.data.submission.formVersionId).toBe(v2.body.data.versionId);

    // Re-read from the database: the first one still points to version 1.
    const stored = await FormSubmission.findById(first.body.data.submission.id).lean();
    expect(stored?.version).toBe(1);
    expect(stored?.formVersionId.toString()).toBe(v1.body.data.versionId);
  });

  it("rejects an option that was removed in the newer version", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, schemaOf(countryField(["old"])));
    await publish(tenant, formId);
    expect((await submit(tenant, formId, { data: { country: "old" } })).status).toBe(201);

    await save(tenant, formId, schemaOf(countryField(["new"])));
    await publish(tenant, formId);

    expectInvalid(await submit(tenant, formId, { data: { country: "old" } }), "country", /options/);
    expect((await submit(tenant, formId, { data: { country: "new" } })).status).toBe(201);
  });

  it("does not use unpublished draft edits to accept new options", async () => {
    const { tenant, formId } = await setup(schemaOf(countryField(["india"])));
    await save(tenant, formId, schemaOf(countryField(["india", "spain"])));

    expectInvalid(await submit(tenant, formId, { data: { country: "spain" } }), "country");
  });
});

describe("authentication, authorization and tenant isolation", () => {
  it("requires authentication", async () => {
    const { formId } = await setup();

    const res = await request(app).post(`/api/forms/${formId}/submissions`).send({ data: validData });

    expect(res.status).toBe(401);
  });

  it("requires submission.create", async () => {
    const { formId } = await setup();
    const limited = await createTenant(
      OWNER_PERMISSIONS.filter((p) => p !== PERMISSIONS.SUBMISSION_CREATE),
    );

    const res = await submit(limited, formId, { data: validData });

    expect(res.status).toBe(403);
    expectStandardError(res.body as ErrorBody, "FORBIDDEN");
  });

  it("does not let tenant A submit to tenant B's form", async () => {
    const b = await setup();
    const a = await createTenant();

    const res = await submit(a, b.formId, { data: validData });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    expect(await FormSubmission.countDocuments({})).toBe(0);
  });

  it("answers the same for another tenant's unpublished form", async () => {
    const b = await createTenant();
    const formId = await createForm(b);
    const a = await createTenant();

    const res = await submit(a, formId, { data: {} });

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
  });

  it("records the caller's organization and user, whatever the request says", async () => {
    const { tenant, formId } = await setup();
    const other = await createTenant();

    const res = await submit(tenant, formId, { data: validData, organizationId: other.user.organizationId });
    expect(res.status).toBe(400);

    const ok = await submit(tenant, formId, { data: validData });
    const stored = await FormSubmission.findById(ok.body.data.submission.id).lean();
    expect(stored?.organizationId.toString()).toBe(tenant.user.organizationId);
    expect(stored?.submittedBy.toString()).toBe(tenant.user.userId);
  });
});
