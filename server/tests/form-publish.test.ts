import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { redisClient } from "../src/config/redis.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { FormVersion } from "../src/models/form-version.model.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { publishedFormCacheKey } from "../src/repositories/published-form-cache.repository.js";
import { canonicalJson } from "../src/utils/canonical-json.util.js";
import {
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
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.17.13 — POST /api/forms/:id/publish.
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

let slugCounter = 0;

const createFormViaApi = async (tenant: Tenant): Promise<string> => {
  slugCounter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact Form",
      slug: `contact-form-${slugCounter}`,
      status: "draft",
      projectId: tenant.projectId,
    });
  expect(res.status).toBe(201);
  return res.body.data.form._id as string;
};

const saveDraft = (tenant: Tenant, formId: string, draft: unknown) =>
  request(app)
    .patch(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant))
    .send({ draftSchema: draft });

const publish = (tenant: Tenant, formId: string) =>
  request(app)
    .post(`/api/forms/${formId}/publish`)
    .set("Authorization", auth(tenant));

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

const draftOf = (...fields: unknown[]) => ({ version: 1, fields });

/* Writes a draft straight to the database, bypassing the save endpoint's
 * validation, to prove that publishing validates on its own. */
const seedRawDraft = async (formId: string, draft: unknown) => {
  await Form.updateOne({ _id: formId }, { $set: { draftSchema: draft } });
};

const setup = async (draft: unknown = draftOf(textField("name"))) => {
  const tenant = await createTenant();
  const formId = await createFormViaApi(tenant);
  const saved = await saveDraft(tenant, formId, draft);
  expect(saved.status).toBe(200);
  return { tenant, formId };
};

const expectCode = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expectStandardError(res.body as ErrorBody, code);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("successful publishing", () => {
  it("publishes the first version", async () => {
    const { tenant, formId } = await setup();

    const res = await publish(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Form published successfully");
    expect(res.body.data).toMatchObject({
      formId,
      version: 1,
      status: "PUBLISHED",
    });
    expect(typeof res.body.data.versionId).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.data.publishedAt))).toBe(false);

    const form = await Form.findById(formId);
    expect(form?.status).toBe("PUBLISHED");
    expect(form?.publishedVersionId?.toString()).toBe(res.body.data.versionId);
  });

  it("creates versions 2 and 3 on later publishes, with correct numbers", async () => {
    const { tenant, formId } = await setup();

    const v1 = await publish(tenant, formId);
    await saveDraft(tenant, formId, draftOf(textField("name"), textField("b")));
    const v2 = await publish(tenant, formId);
    await saveDraft(
      tenant,
      formId,
      draftOf(textField("name"), textField("b"), textField("c")),
    );
    const v3 = await publish(tenant, formId);

    expect([v1, v2, v3].map((r) => r.body.data.version)).toEqual([1, 2, 3]);

    const versions = await FormVersion.find({ formId }).sort({ version: 1 });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);

    const form = await Form.findById(formId);
    expect(form?.publishedVersionId?.toString()).toBe(v3.body.data.versionId);
  });

  it("stores a snapshot of the schema and records who published it", async () => {
    const draft = draftOf(textField("name"), dropdownField("country"));
    const { tenant, formId } = await setup(draft);

    const res = await publish(tenant, formId);

    const version = await FormVersion.findById(res.body.data.versionId);
    expect(version?.schemaSnapshot).toEqual(draft);
    expect(version?.status).toBe("PUBLISHED");
    expect(version?.organizationId.toString()).toBe(tenant.user.organizationId);
    expect(version?.formId.toString()).toBe(formId);
    expect(version?.createdBy.toString()).toBe(tenant.user.userId);
    expect(version?.publishedBy.toString()).toBe(tenant.user.userId);
    expect(version?.publishedAt).toBeInstanceOf(Date);
    expect(version?.settings).toEqual({});
  });

  it("keeps the draft intact and editable after publishing", async () => {
    const draft = draftOf(textField("name"));
    const { tenant, formId } = await setup(draft);

    await publish(tenant, formId);

    const form = await Form.findById(formId);
    expect(form?.draftSchema).toEqual(draft);

    const edited = draftOf(textField("name"), textField("extra"));
    const save = await saveDraft(tenant, formId, edited);
    expect(save.status).toBe(200);
    expect((await Form.findById(formId))?.draftSchema).toEqual(edited);
    // The save did not change the published pointer or status.
    expect((await Form.findById(formId))?.status).toBe("PUBLISHED");
  });

  it("does not create a version when the draft is saved", async () => {
    const { tenant, formId } = await setup();
    await saveDraft(tenant, formId, draftOf(textField("other")));

    expect(await FormVersion.countDocuments({ formId })).toBe(0);
  });

  it("numbers versions per form, independently of other forms and tenants", async () => {
    const a = await setup();
    const b = await setup();

    const ra = await publish(a.tenant, a.formId);
    const rb = await publish(b.tenant, b.formId);

    expect(ra.body.data.version).toBe(1);
    expect(rb.body.data.version).toBe(1);
  });
});

describe("immutability", () => {
  it("cannot modify or delete a published version through the model", async () => {
    const { tenant, formId } = await setup();
    const res = await publish(tenant, formId);
    const id = res.body.data.versionId as string;
    const before = (await FormVersion.findById(id))?.toObject();

    await expect(
      FormVersion.updateOne({ _id: id }, { $set: { schemaSnapshot: {} } }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      FormVersion.findOneAndUpdate({ _id: id }, { $set: { version: 9 } }),
    ).rejects.toThrow(/immutable/i);
    await expect(FormVersion.replaceOne({ _id: id }, {})).rejects.toThrow(/immutable/i);
    await expect(FormVersion.deleteOne({ _id: id })).rejects.toThrow(/immutable/i);
    await expect(FormVersion.deleteMany({ formId })).rejects.toThrow(/immutable/i);

    const doc = await FormVersion.findById(id);
    doc!.schemaSnapshot = { version: 1, fields: [] };
    await expect(doc!.save()).rejects.toThrow(/immutable/i);
    await expect(doc!.deleteOne()).rejects.toThrow(/immutable/i);

    const after = (await FormVersion.findById(id))?.toObject();
    expect(after).toEqual(before);
  });

  it("exposes no endpoint to edit or delete a version", async () => {
    const { tenant, formId } = await setup();
    const res = await publish(tenant, formId);
    const versionId = res.body.data.versionId as string;

    for (const method of ["patch", "put", "delete"] as const) {
      const r = await request(app)
        [method](`/api/forms/${formId}/versions/${versionId}`)
        .set("Authorization", auth(tenant))
        .send({});
      expect(r.status).toBe(404);
    }
  });

  it("leaves a published version unchanged when the draft is edited and republished", async () => {
    const original = draftOf(textField("name"));
    const { tenant, formId } = await setup(original);
    const v1 = await publish(tenant, formId);

    await saveDraft(tenant, formId, draftOf(textField("name", { label: "Changed" })));

    const afterEdit = await FormVersion.findById(v1.body.data.versionId);
    expect(afterEdit?.schemaSnapshot).toEqual(original);

    const v2 = await publish(tenant, formId);
    expect(v2.body.data.version).toBe(2);

    const v1Again = await FormVersion.findById(v1.body.data.versionId);
    expect(v1Again?.schemaSnapshot).toEqual(original);
    expect(canonicalJson((await FormVersion.findById(v2.body.data.versionId))?.schemaSnapshot)).toContain(
      "Changed",
    );
  });
});

describe("publish-time validation", () => {
  const invalidCases: [string, () => unknown][] = [
    ["a non-object schema", () => "not a schema"],
    ["an empty form", () => draftOf()],
    ["duplicate field ids", () => draftOf(textField("a"), textField("a"))],
    ["an unsupported field type", () => draftOf({ ...textField("a"), type: "FILE" })],
    ["an invalid field id", () => draftOf(textField("1bad id"))],
    ["an empty field label", () => draftOf(textField("a", { label: "  " }))],
    ["an unknown field property", () => draftOf(textField("a", { onClick: "x" }))],
    ["a non-boolean required flag", () => draftOf(textField("a", { required: "yes" }))],
    ["a dropdown with no options", () => draftOf(dropdownField("d", { options: [] }))],
    [
      "dropdown options with a duplicate value",
      () =>
        draftOf(
          dropdownField("d", {
            options: [
              { label: "A", value: "x" },
              { label: "B", value: "x" },
            ],
          }),
        ),
    ],
    [
      "a dropdown option with an empty label",
      () => draftOf(dropdownField("d", { options: [{ label: "", value: "x" }] })),
    ],
    [
      "a dropdown default that is not an option",
      () => draftOf(dropdownField("d", { defaultValue: "zzz" })),
    ],
    [
      "minLength greater than maxLength",
      () => draftOf(textField("a", { validation: { minLength: 9, maxLength: 3 } })),
    ],
    [
      "a negative minLength",
      () => draftOf(textField("a", { validation: { minLength: -1 } })),
    ],
    [
      "a regular expression that does not compile",
      () => draftOf(textField("a", { validation: { pattern: "(" } })),
    ],
    [
      "an unknown validation rule",
      () => draftOf(textField("a", { validation: { custom: "alert(1)" } })),
    ],
    [
      "conditional logic referencing a missing field",
      () => draftOf(textField("a", { conditionalLogic: { show: { field: "ghost", equals: 1 } } })),
    ],
    [
      "circular conditional logic",
      () =>
        draftOf(
          textField("a", { conditionalLogic: { show: { field: "b", equals: 1 } } }),
          textField("b", { conditionalLogic: { show: { field: "a", equals: 1 } } }),
        ),
    ],
    [
      "too many fields",
      () =>
        draftOf(
          ...Array.from({ length: MAX_DRAFT_SCHEMA_FIELDS + 1 }, (_, i) =>
            textField(`f${i}`),
          ),
        ),
    ],
    [
      "an oversized schema",
      () =>
        draftOf(
          ...[0, 1].map((n) =>
            dropdownField(`big${n}`, {
              options: Array.from({ length: 500 }, (_, i) => ({
                label: "L".repeat(200),
                value: `${n}-${i}-${"V".repeat(190)}`,
              })),
            }),
          ),
        ),
    ],
    ["an extra top-level property", () => ({ ...draftOf(textField("a")), extra: 1 })],
    [
      "a prototype-pollution key",
      () =>
        JSON.parse(
          '{"version":1,"fields":[],"__proto__":{"polluted":true},"constructor":{}}',
        ) as unknown,
    ],
    [
      "a NoSQL operator key",
      () => ({ ...draftOf(textField("a")), $where: "1" }),
    ],
  ];

  it.each(invalidCases)("rejects %s with 400 and publishes nothing", async (_name, build) => {
    const { tenant, formId } = await setup();
    await seedRawDraft(formId, build());
    const draftBefore = (await Form.findById(formId))?.draftSchema;

    const res = await publish(tenant, formId);

    expectCode(res, 400, "FORM_SCHEMA_INVALID");
    expect(await FormVersion.countDocuments({ formId })).toBe(0);
    expect(await AuditLog.countDocuments({ action: "FORM_PUBLISHED" })).toBe(0);

    // The draft was neither repaired nor changed, and the form stays a draft.
    const form = await Form.findById(formId);
    expect(form?.draftSchema).toEqual(draftBefore);
    expect(form?.status).toBe("DRAFT");
    expect(form?.publishedVersionId).toBeUndefined();
  });

  it("reports which field is invalid", async () => {
    const { tenant, formId } = await setup();
    await seedRawDraft(formId, draftOf(textField("a", { label: "" })));

    const res = await publish(tenant, formId);

    expect(res.body.error.fields["fields.0.label"]).toBeTruthy();
  });

  it("rejects a form with no draft", async () => {
    const tenant = await createTenant();
    const formId = await createFormViaApi(tenant);

    const res = await publish(tenant, formId);

    expectCode(res, 400, "FORM_DRAFT_MISSING");
    expect(await FormVersion.countDocuments({ formId })).toBe(0);
  });

  it("rejects publishing an archived form", async () => {
    const { tenant, formId } = await setup();
    await Form.updateOne({ _id: formId }, { $set: { status: "ARCHIVED" } });

    const res = await publish(tenant, formId);

    expectCode(res, 409, "FORM_ARCHIVED");
  });

  it("rejects a request body: the server decides what is published", async () => {
    const { tenant, formId } = await setup();

    const res = await request(app)
      .post(`/api/forms/${formId}/publish`)
      .set("Authorization", auth(tenant))
      .send({ organizationId: objectId(), draftSchema: draftOf(textField("evil")) });

    expect(res.status).toBe(400);
    expect(await FormVersion.countDocuments({ formId })).toBe(0);
  });
});

describe("authentication, authorization and tenant isolation", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { formId } = await setup();

    const res = await request(app).post(`/api/forms/${formId}/publish`);

    expectCode(res, 401, "UNAUTHORIZED");
  });

  it("rejects a user without form.publish with 403", async () => {
    const tenant = await createTenant(
      OWNER_PERMISSIONS.filter((p) => p !== PERMISSIONS.FORM_PUBLISH),
    );
    const formId = await createFormViaApi(tenant);
    await saveDraft(tenant, formId, draftOf(textField("a")));

    const res = await publish(tenant, formId);

    expectCode(res, 403, "FORBIDDEN");
    expect(await FormVersion.countDocuments({ formId })).toBe(0);
    expect((await Form.findById(formId))?.status).toBe("DRAFT");
  });

  it("cannot publish another organization's form", async () => {
    const a = await setup();
    const b = await createTenant();

    const res = await publish(b, a.formId);

    expectCode(res, 404, "FORM_NOT_FOUND");
    expect(await FormVersion.countDocuments({ formId: a.formId })).toBe(0);
    expect((await Form.findById(a.formId))?.status).toBe("DRAFT");
  });

  it("returns the same 404 for a form that does not exist", async () => {
    const tenant = await createTenant();

    const res = await publish(tenant, objectId());

    expectCode(res, 404, "FORM_NOT_FOUND");
  });

  it("rejects a malformed form id with 400", async () => {
    const tenant = await createTenant();

    const res = await publish(tenant, "not-an-id");

    expect(res.status).toBe(400);
  });

  it("scopes version records to the publisher's organization", async () => {
    const { tenant, formId } = await setup();
    const res = await publish(tenant, formId);

    const version = await FormVersion.findById(res.body.data.versionId);
    expect(version?.organizationId.toString()).toBe(tenant.user.organizationId);
  });
});

describe("audit log", () => {
  it("records FORM_PUBLISHED with safe metadata only", async () => {
    const { tenant, formId } = await setup();

    const res = await publish(tenant, formId);

    const logs = await AuditLog.find({ action: "FORM_PUBLISHED" });
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.resourceType).toBe("FORM");
    expect(log.resourceId?.toString()).toBe(formId);
    expect(log.organizationId.toString()).toBe(tenant.user.organizationId);
    expect(log.userId.toString()).toBe(tenant.user.userId);
    expect(log.metadata).toEqual({
      formId,
      version: 1,
      versionId: res.body.data.versionId,
    });

    const serialized = JSON.stringify(log.toObject());
    expect(serialized).not.toContain("fields");
    expect(serialized).not.toContain(tenant.session.accessToken);
    expect(serialized).not.toContain(tenant.session.refreshToken);
  });
});

describe("published-form cache", () => {
  it("invalidates only this form's cache entry, after publishing", async () => {
    const { tenant, formId } = await setup();
    const key = publishedFormCacheKey(tenant.user.organizationId, formId);
    const otherForm = publishedFormCacheKey(tenant.user.organizationId, objectId());
    const otherTenant = publishedFormCacheKey(objectId(), formId);
    await redisClient.set(key, "stale");
    await redisClient.set(otherForm, "keep");
    await redisClient.set(otherTenant, "keep");
    await redisClient.set("unrelated", "keep");

    const res = await publish(tenant, formId);

    expect(res.status).toBe(200);
    expect(await redisClient.get(key)).toBeNull();
    expect(await redisClient.get(otherForm)).toBe("keep");
    expect(await redisClient.get(otherTenant)).toBe("keep");
    expect(await redisClient.get("unrelated")).toBe("keep");
  });

  it("does not invalidate when publishing is rejected", async () => {
    const { tenant, formId } = await setup();
    await seedRawDraft(formId, draftOf());
    const key = publishedFormCacheKey(tenant.user.organizationId, formId);
    await redisClient.set(key, "cached");

    const res = await publish(tenant, formId);

    expect(res.status).toBe(400);
    expect(await redisClient.get(key)).toBe("cached");
  });

  it("invalidates only after the transaction commits", async () => {
    const { tenant, formId } = await setup();
    const del = vi.spyOn(redisClient, "del");

    vi.spyOn(AuditLog.prototype, "save").mockRejectedValueOnce(new Error("audit down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await publish(tenant, formId);

    expect(failed.status).toBe(500);
    expect(del).not.toHaveBeenCalled();
  });

  it("still reports success if the cache cannot be invalidated, and logs it", async () => {
    const { tenant, formId } = await setup();
    vi.spyOn(redisClient, "del").mockRejectedValueOnce(new Error("redis down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await publish(tenant, formId);

    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalled();
    expect(await FormVersion.countDocuments({ formId })).toBe(1);
  });
});

describe("atomicity and concurrency", () => {
  it("leaves no partial state when the audit write fails", async () => {
    const { tenant, formId } = await setup();
    vi.spyOn(AuditLog.prototype, "save").mockRejectedValueOnce(new Error("audit down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await publish(tenant, formId);

    expect(res.status).toBe(500);
    expect(await FormVersion.countDocuments({ formId })).toBe(0);
    const form = await Form.findById(formId);
    expect(form?.status).toBe("DRAFT");
    expect(form?.publishedVersionId).toBeUndefined();

    // Nothing leaked to the client, and a retry works.
    expect(JSON.stringify(res.body)).not.toContain("audit down");
    const retry = await publish(tenant, formId);
    expect(retry.status).toBe(200);
    expect(retry.body.data.version).toBe(1);
  });

  it("does not leave an orphan version when updating the form fails", async () => {
    const { tenant, formId } = await setup();
    vi.spyOn(Form, "findOneAndUpdate").mockImplementationOnce((() => ({
      exec: () => Promise.reject(new Error("update failed")),
    })) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await publish(tenant, formId);

    expect(res.status).toBe(500);
    expect(await FormVersion.countDocuments({ formId })).toBe(0);
  });

  it("concurrent publishes create exactly one version; the others get a 409", async () => {
    const { tenant, formId } = await setup();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => publish(tenant, formId)),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(["PUBLISH_CONFLICT", "FORM_NO_CHANGES"]).toContain(r.body.error.code);
    }

    const versions = await FormVersion.find({ formId });
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(await AuditLog.countDocuments({ action: "FORM_PUBLISHED" })).toBe(1);
  });

  it("never reuses a version number under concurrent republishing", async () => {
    const { tenant, formId } = await setup();
    await publish(tenant, formId);
    await saveDraft(tenant, formId, draftOf(textField("name"), textField("b")));

    const results = await Promise.all([
      publish(tenant, formId),
      publish(tenant, formId),
    ]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const versions = (await FormVersion.find({ formId }).sort({ version: 1 })).map(
      (v) => v.version,
    );
    expect(versions).toEqual([1, 2]);
  });
});

describe("unchanged drafts", () => {
  it("rejects publishing a draft identical to the published version", async () => {
    const { tenant, formId } = await setup();
    await publish(tenant, formId);

    const res = await publish(tenant, formId);

    expectCode(res, 409, "FORM_NO_CHANGES");
    expect(await FormVersion.countDocuments({ formId })).toBe(1);
    expect(await AuditLog.countDocuments({ action: "FORM_PUBLISHED" })).toBe(1);
  });

  it("is deterministic: the same request keeps returning the same 409", async () => {
    const { tenant, formId } = await setup();
    await publish(tenant, formId);

    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await publish(tenant, formId)).body.error.code);
    }

    expect(codes).toEqual(["FORM_NO_CHANGES", "FORM_NO_CHANGES", "FORM_NO_CHANGES"]);
  });

  it("treats a draft edited and then reverted as unchanged, regardless of key order", async () => {
    const original = draftOf(textField("name"));
    const { tenant, formId } = await setup(original);
    await publish(tenant, formId);
    await saveDraft(tenant, formId, draftOf(textField("name", { label: "Other" })));
    await saveDraft(tenant, formId, original);

    const res = await publish(tenant, formId);

    expectCode(res, 409, "FORM_NO_CHANGES");
  });

  it("allows publishing again after a real change", async () => {
    const { tenant, formId } = await setup();
    await publish(tenant, formId);
    await saveDraft(tenant, formId, draftOf(textField("name"), textField("more")));

    const res = await publish(tenant, formId);

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
  });
});
