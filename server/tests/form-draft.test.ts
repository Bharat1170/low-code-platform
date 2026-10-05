import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import app from "../src/app.js";
import { PERMISSIONS, type Permission } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import {
  MAX_DRAFT_SCHEMA_BYTES,
  MAX_DRAFT_SCHEMA_FIELDS,
} from "../src/validators/form-draft-schema.validator.js";

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
 * 8.17.11 — saving the builder draft through PATCH /api/forms/:id.
 * Real routes, auth, permissions, service, repository and MongoDB.
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

const allBut = (permission: Permission): Promise<Tenant> =>
  createTenant(
    [
      PERMISSIONS.FORM_CREATE,
      PERMISSIONS.FORM_READ,
      PERMISSIONS.FORM_UPDATE,
      PERMISSIONS.FORM_DELETE,
    ].filter((p) => p !== permission),
    ROLE_NAMES.BUILDER,
  );

const auth = (tenant: Tenant): string => bearer(tenant.session.accessToken);

const createFormViaApi = async (tenant: Tenant): Promise<string> => {
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact Form",
      slug: "contact-form",
      status: "draft",
      projectId: tenant.projectId,
    });
  expect(res.status).toBe(201);
  return res.body.data.form._id as string;
};

const saveDraft = (tenant: Tenant, formId: string, body: unknown) =>
  request(app)
    .patch(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant))
    .send(body as object);

const getForm = (tenant: Tenant, formId: string) =>
  request(app)
    .get(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant));

const expectCode = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expectStandardError(res.body as ErrorBody, code);
};

const textField = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "TEXT",
  label: "Name",
  description: "",
  required: false,
  config: { placeholder: "Your name", defaultValue: "" },
  validation: {},
  conditionalLogic: null,
  ...overrides,
});

const dropdownField = (id: string, config: Record<string, unknown> = {}) => ({
  id,
  type: "DROPDOWN",
  label: "Country",
  description: "",
  required: true,
  config: {
    placeholder: "Select",
    options: [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ],
    defaultValue: "",
    ...config,
  },
  validation: { required: true },
  conditionalLogic: null,
});

const validSchema = () => ({
  version: 1,
  fields: [
    textField("name_field"),
    {
      id: "email_field",
      type: "EMAIL",
      label: "Email",
      description: "We never share it",
      required: true,
      config: { placeholder: "you@example.com", defaultValue: "" },
      validation: { email: true, maxLength: 120, pattern: "^[^@]+@[^@]+$" },
      conditionalLogic: null,
    },
    dropdownField("country_field"),
    {
      id: "agree_field",
      type: "CHECKBOX",
      label: "Agree",
      description: "",
      required: false,
      config: { defaultValue: false },
      validation: {},
      conditionalLogic: null,
    },
  ],
});

let owner: Tenant;
let formId: string;

beforeAll(async () => {
  await Form.init();
});

beforeEach(async () => {
  await resetRateLimits();
  owner = await createTenant();
  formId = await createFormViaApi(owner);
});

describe("saving a valid draft", () => {
  it("create -> get -> save draft -> get returns the persisted draft", async () => {
    const before = await getForm(owner, formId);
    expect(before.status).toBe(200);
    expect(before.body.data.form.draftSchema).toBeUndefined();

    const schema = validSchema();
    const saved = await saveDraft(owner, formId, { draftSchema: schema });

    expect(saved.status).toBe(200);
    expect(saved.body.message).toBe("Form updated successfully");
    expect(saved.body.data.form.draftSchema).toEqual(schema);

    const after = await getForm(owner, formId);
    // Round-trips exactly, including empty objects such as validation: {}.
    expect(after.body.data.form.draftSchema).toEqual(schema);
    expect(
      (await Form.findById(formId).lean())?.draftSchema,
    ).toEqual(schema);
  });

  it("accepts an empty form schema and later overwrites the same single draft", async () => {
    await saveDraft(owner, formId, {
      draftSchema: { version: 1, fields: [] },
    });
    const second = validSchema();
    await saveDraft(owner, formId, { draftSchema: second });
    const third = { ...second, fields: second.fields.slice(0, 1) };
    const res = await saveDraft(owner, formId, { draftSchema: third });

    expect(res.status).toBe(200);
    expect(res.body.data.form.draftSchema).toEqual(third);
    expect(await Form.countDocuments({})).toBe(1);
  });

  it("does not change status, project, versions, name or slug", async () => {
    const before = await Form.findById(formId).lean();

    await saveDraft(owner, formId, { draftSchema: validSchema() });

    const after = await Form.findById(formId).lean();
    expect(after?.status).toBe("DRAFT");
    expect(after?.projectId.toString()).toBe(before?.projectId.toString());
    expect(after?.name).toBe(before?.name);
    expect(after?.slug).toBe(before?.slug);
    expect(after?.organizationId.toString()).toBe(
      owner.user.organizationId,
    );
    expect(after?.createdBy.toString()).toBe(owner.user.userId);
    expect(after?.publishedVersionId).toBeUndefined();
    expect(after?.currentDraftVersionId).toBeUndefined();
    expect(after?.updatedBy?.toString()).toBe(owner.user.userId);
  });

  it("keeps the draft out of the list response", async () => {
    await saveDraft(owner, formId, { draftSchema: validSchema() });

    const res = await request(app)
      .get("/api/forms")
      .set("Authorization", auth(owner));

    expect(res.status).toBe(200);
    expect(res.body.data.forms).toHaveLength(1);
    expect(res.body.data.forms[0]).not.toHaveProperty("draftSchema");
  });
});

describe("authentication and authorization", () => {
  it("rejects an unauthenticated draft save with 401", async () => {
    const res = await request(app)
      .patch(`/api/forms/${formId}`)
      .send({ draftSchema: validSchema() });

    expect(res.status).toBe(401);
    expect((await Form.findById(formId).lean())?.draftSchema).toBeUndefined();
  });

  it("rejects expired and forged tokens with 401", async () => {
    const expired = signAccessToken(owner.user, {
      claims: { sessionId: owner.session.sessionId },
      options: { expiresIn: -60 },
    });
    const forged = signAccessToken(owner.user, {
      claims: { sessionId: owner.session.sessionId },
      secret: "x".repeat(40),
    });

    for (const token of ["garbage", expired, forged]) {
      const res = await request(app)
        .patch(`/api/forms/${formId}`)
        .set("Authorization", bearer(token))
        .send({ draftSchema: validSchema() });

      expect(res.status).toBe(401);
    }
  });

  it("requires FORM_UPDATE (403 FORBIDDEN)", async () => {
    const noUpdate = await allBut(PERMISSIONS.FORM_UPDATE);
    const own = await createFormViaApi(noUpdate);

    const res = await saveDraft(noUpdate, own, {
      draftSchema: validSchema(),
    });

    expectCode(res, 403, "FORBIDDEN");
    expect((await Form.findById(own).lean())?.draftSchema).toBeUndefined();
  });

  it("returns FORM_NOT_FOUND for another organization's form and changes nothing", async () => {
    const other = await createTenant();

    const res = await saveDraft(other, formId, {
      draftSchema: validSchema(),
    });

    expectCode(res, 404, "FORM_NOT_FOUND");
    expect((await Form.findById(formId).lean())?.draftSchema).toBeUndefined();
  });
});

describe("mass assignment and operator safety", () => {
  it.each([
    ["organizationId", () => objectId()],
    ["createdBy", () => objectId()],
    ["updatedBy", () => objectId()],
    ["publishedVersionId", () => objectId()],
    ["currentDraftVersionId", () => objectId()],
    ["_id", () => objectId()],
    ["createdAt", () => "2000-01-01T00:00:00.000Z"],
    ["unknownField", () => "x"],
  ])("rejects %s sent with a draft", async (field, value) => {
    const res = await saveDraft(owner, formId, {
      draftSchema: validSchema(),
      [field]: value(),
    });

    expectCode(res, 400, "VALIDATION_ERROR");

    const stored = await Form.findById(formId).lean();
    expect(stored?.draftSchema).toBeUndefined();
    expect(stored?.organizationId.toString()).toBe(owner.user.organizationId);
    expect(stored?.createdBy.toString()).toBe(owner.user.userId);
    expect(stored?.publishedVersionId).toBeUndefined();
    expect(stored?.currentDraftVersionId).toBeUndefined();
  });

  it.each([
    ["projectId", () => objectId()],
    ["status", () => "PUBLISHED"],
    ["name", () => "Hijacked"],
    ["slug", () => "hijacked"],
  ])("a draft save cannot also change %s", async (field, value) => {
    const before = await Form.findById(formId).lean();

    const res = await saveDraft(owner, formId, {
      draftSchema: validSchema(),
      [field]: value(),
    });

    expectCode(res, 400, "VALIDATION_ERROR");

    const after = await Form.findById(formId).lean();
    expect(after?.draftSchema).toBeUndefined();
    expect(after?.status).toBe(before?.status);
    expect(after?.projectId.toString()).toBe(before?.projectId.toString());
    expect(after?.name).toBe(before?.name);
    expect(after?.slug).toBe(before?.slug);
  });

  it("rejects operator and prototype payloads at the top level", async () => {
    const schema = JSON.stringify(validSchema());

    for (const raw of [
      `{"draftSchema":${schema},"$set":{"organizationId":"${objectId()}"}}`,
      `{"draftSchema":${schema},"$where":"1==1"}`,
      `{"draftSchema":${schema},"__proto__":{"admin":true}}`,
      `{"draftSchema":${schema},"constructor":{"prototype":{"admin":true}}}`,
      `{"draftSchema":${schema},"prototype":{"x":1}}`,
      '{"draftSchema":{"$set":{"x":1}}}',
      '{"draftSchema":{"$ne":null}}',
    ]) {
      const res = await request(app)
        .patch(`/api/forms/${formId}`)
        .set("Authorization", auth(owner))
        .set("Content-Type", "application/json")
        .send(raw);

      expect(res.status, raw).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    }

    expect((await Form.findById(formId).lean())?.draftSchema).toBeUndefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("rejects operators and prototype keys inside the schema", async () => {
    const schemas = [
      { ...validSchema(), $where: "1==1" },
      { ...validSchema(), constructor: { prototype: { x: 1 } } },
      JSON.parse('{"version":1,"fields":[],"__proto__":{"admin":true}}'),
      {
        version: 1,
        fields: [textField("a", { $set: { required: true } })],
      },
      {
        version: 1,
        fields: [textField("a", { config: { placeholder: "", defaultValue: "", $gt: 1 } })],
      },
      {
        version: 1,
        fields: [textField("a", { label: { $ne: "" } })],
      },
    ];

    for (const draftSchema of schemas) {
      const res = await saveDraft(owner, formId, { draftSchema });

      expectCode(res, 400, "VALIDATION_ERROR");
    }

    expect((await Form.findById(formId).lean())?.draftSchema).toBeUndefined();
  });
});

describe("schema validation", () => {
  const rejected = async (draftSchema: unknown) => {
    const res = await saveDraft(owner, formId, { draftSchema });

    expectCode(res, 400, "VALIDATION_ERROR");
    expect((await Form.findById(formId).lean())?.draftSchema).toBeUndefined();
  };

  it("rejects a non-object or empty draftSchema", async () => {
    for (const value of [null, "schema", 5, [], {}]) {
      await rejected(value);
    }
  });

  it("rejects an unknown field type", async () => {
    await rejected({
      version: 1,
      fields: [textField("a", { type: "NUMBER" })],
    });
    await rejected({
      version: 1,
      fields: [textField("a", { type: "constructor" })],
    });
  });

  it("rejects duplicate field ids", async () => {
    await rejected({
      version: 1,
      fields: [textField("same"), textField("same")],
    });
  });

  it("rejects invalid field ids", async () => {
    for (const id of ["", "1abc", "has space", "a;b", "$where", "x".repeat(65)]) {
      await rejected({ version: 1, fields: [textField(id)] });
    }
  });

  it("rejects invalid dropdown options", async () => {
    await rejected({
      version: 1,
      fields: [dropdownField("d", { options: [{ label: "A" }] })],
    });
    await rejected({
      version: 1,
      fields: [dropdownField("d", { options: [{ label: "", value: "a" }] })],
    });
    await rejected({
      version: 1,
      fields: [
        dropdownField("d", {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "a" },
          ],
        }),
      ],
    });
    await rejected({
      version: 1,
      fields: [dropdownField("d", { options: "a,b" })],
    });
    await rejected({
      version: 1,
      fields: [dropdownField("d", { defaultValue: "not-an-option" })],
    });
  });

  it("rejects a config that belongs to another field type", async () => {
    await rejected({
      version: 1,
      fields: [
        textField("a", {
          config: { placeholder: "", defaultValue: "", options: [] },
        }),
      ],
    });
  });

  it("rejects invalid validation rules", async () => {
    for (const validation of [
      { pattern: "(" },
      { pattern: 5 },
      { minLength: -1 },
      { minLength: 5, maxLength: 1 },
      { min: 5, max: 1 },
      { custom: "x" },
      { required: "yes" },
    ]) {
      await rejected({ version: 1, fields: [textField("a", { validation })] });
    }
  });

  it("rejects wrong versions and missing members", async () => {
    await rejected({ version: 0, fields: [] });
    await rejected({ version: 1.5, fields: [] });
    await rejected({ fields: [] });
    await rejected({ version: 1 });
    await rejected({ version: 1, fields: {} });
  });

  it("rejects non-null conditionalLogic", async () => {
    await rejected({
      version: 1,
      fields: [textField("a", { conditionalLogic: { when: "x" } })],
    });
  });
});

describe("size limits", () => {
  it("rejects more fields than the limit", async () => {
    const fields = Array.from({ length: MAX_DRAFT_SCHEMA_FIELDS + 1 }, (_, i) =>
      textField(`f${i}`),
    );

    const res = await saveDraft(owner, formId, {
      draftSchema: { version: 1, fields },
    });

    expectCode(res, 400, "VALIDATION_ERROR");
  });

  it("accepts the maximum number of fields", async () => {
    const fields = Array.from({ length: MAX_DRAFT_SCHEMA_FIELDS }, (_, i) =>
      textField(`f${i}`),
    );

    const res = await saveDraft(owner, formId, {
      draftSchema: { version: 1, fields },
    });

    expect(res.status).toBe(200);
  });

  it("rejects a draft over the serialized size limit", async () => {
    // Few fields, each with the largest allowed text, to exceed the cap
    // without exceeding the field-count or global body limits.
    const options = Array.from({ length: 500 }, (_, i) => ({
      label: "L".repeat(200),
      value: `${"v".repeat(190)}${i}`,
    }));
    const draftSchema = {
      version: 1,
      fields: [
        dropdownField("d1", { options }),
        dropdownField("d2", { options }),
      ],
    };

    expect(
      Buffer.byteLength(JSON.stringify(draftSchema)),
    ).toBeGreaterThan(MAX_DRAFT_SCHEMA_BYTES);

    const res = await saveDraft(owner, formId, { draftSchema });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect((await Form.findById(formId).lean())?.draftSchema).toBeUndefined();
  });

  it("returns 413 when the request body exceeds the global 1 MB limit", async () => {
    const res = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(owner))
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ draftSchema: { pad: "x".repeat(1_100_000) } }));

    expect(res.status).toBe(413);
  });
});

describe("existing update behavior is preserved", () => {
  it("still updates metadata without a draftSchema", async () => {
    const res = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(owner))
      .send({ name: "Renamed", status: "archived" });

    expect(res.status).toBe(200);
    expect(res.body.data.form).toMatchObject({
      name: "Renamed",
      status: "ARCHIVED",
    });
  });

  it("a metadata update keeps the saved draft", async () => {
    const schema = validSchema();
    await saveDraft(owner, formId, { draftSchema: schema });

    const res = await request(app)
      .patch(`/api/forms/${formId}`)
      .set("Authorization", auth(owner))
      .send({ name: "Renamed" });

    expect(res.body.data.form.draftSchema).toEqual(schema);
  });
});
