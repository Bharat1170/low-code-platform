import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { FormSubmission } from "../src/models/form-submission.model.js";
import { FormVersion } from "../src/models/form-version.model.js";
import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { isValidDateOnly } from "../src/utils/date-only.util.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  objectId,
  type TestSession,
  type TestUser,
} from "./helpers.js";
import { expectStandardError, type ErrorBody } from "./security-helpers.js";

/* DATE field: schema validation, publishing and submissions. */

interface Tenant {
  user: TestUser;
  session: TestSession;
  projectId: string;
}

const createTenant = async (): Promise<Tenant> => {
  const user = await createTestUser();
  const role = await Role.create({
    organizationId: user.organizationId,
    name: ROLE_NAMES.OWNER,
    description: "",
    permissions: [...OWNER_PERMISSIONS],
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

const dateField = (
  validation: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) => ({
  id: "birthday",
  type: "DATE",
  label: "Birthday",
  description: "",
  required: false,
  config: { defaultValue: "" },
  validation,
  conditionalLogic: null,
  ...overrides,
});

const textField = (validation: Record<string, unknown> = {}) => ({
  id: "name",
  type: "TEXT",
  label: "Name",
  description: "",
  required: false,
  config: { placeholder: "", defaultValue: "" },
  validation,
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
      name: "Dates",
      slug: `date-form-${counter}`,
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
  request(app).post(`/api/forms/${formId}/publish`).set("Authorization", auth(tenant));

const submit = (tenant: Tenant, formId: string, data: unknown) =>
  request(app)
    .post(`/api/forms/${formId}/submissions`)
    .set("Authorization", auth(tenant))
    .send({ data });

const published = async (...fields: unknown[]) => {
  const tenant = await createTenant();
  const formId = await createForm(tenant);
  expect((await save(tenant, formId, schemaOf(...fields))).status).toBe(200);
  expect((await publish(tenant, formId)).status).toBe(200);
  return { tenant, formId };
};

describe("isValidDateOnly", () => {
  it.each(["2026-01-01", "2024-02-29", "2026-12-31", "0001-01-01"])("accepts %s", (v) => {
    expect(isValidDateOnly(v)).toBe(true);
  });

  it.each([
    "2026-99-99",
    "2026-02-31",
    "2025-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-1-1",
    "26-01-01",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
    "2026/01/01",
    "",
    "0000-01-01",
  ])("rejects %j", (v) => {
    expect(isValidDateOnly(v)).toBe(false);
  });

  it.each([null, undefined, 20260101, {}, [], true])("rejects non-string %j", (v) => {
    expect(isValidDateOnly(v)).toBe(false);
  });
});

describe("DATE in the draft schema", () => {
  it("accepts a DATE field with defaults, bounds and a default value in range", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);

    for (const field of [
      dateField(),
      dateField({ minDate: "2020-01-01", maxDate: "2030-12-31" }),
      dateField({ minDate: "2020-01-01" }),
      dateField({ maxDate: "2030-12-31" }),
      dateField({ minDate: "2026-01-01", maxDate: "2026-01-01" }),
      dateField({ minDate: "2020-01-01", maxDate: "2030-12-31" }, { config: { defaultValue: "2026-06-15" } }),
    ]) {
      expect((await save(tenant, formId, schemaOf(field))).status).toBe(200);
    }
  });

  it("stores the date strings unchanged", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    await save(tenant, formId, schemaOf(dateField({ minDate: "2020-01-01" }, { config: { defaultValue: "2026-06-15" } })));

    const stored = await Form.findById(formId).lean();

    expect(stored?.draftSchema).toEqual(
      schemaOf(dateField({ minDate: "2020-01-01" }, { config: { defaultValue: "2026-06-15" } })),
    );
  });

  it.each([
    ["invalid default value", dateField({}, { config: { defaultValue: "2026-02-31" } })],
    ["non-date default value", dateField({}, { config: { defaultValue: "tomorrow" } })],
    ["date-time default value", dateField({}, { config: { defaultValue: "2026-01-01T00:00:00Z" } })],
    ["numeric default value", dateField({}, { config: { defaultValue: 20260101 } })],
    ["invalid minDate", dateField({ minDate: "2026-99-99" })],
    ["invalid maxDate", dateField({ maxDate: "nope" })],
    ["minDate after maxDate", dateField({ minDate: "2026-12-31", maxDate: "2026-01-01" })],
    ["default before minDate", dateField({ minDate: "2026-06-01" }, { config: { defaultValue: "2026-01-01" } })],
    ["default after maxDate", dateField({ maxDate: "2026-06-01" }, { config: { defaultValue: "2026-12-01" } })],
    ["extra config key", dateField({}, { config: { defaultValue: "", placeholder: "" } })],
    ["unknown validation key", dateField({ before: "2026-01-01" })],
    ["minDate on a TEXT field", { ...textField({ minDate: "2026-01-01" }) }],
    ["maxDate on a TEXT field", { ...textField({ maxDate: "2026-01-01" }) }],
  ])("rejects %s with 400", async (_name, field) => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);

    const res = await save(tenant, formId, schemaOf(field));

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(await Form.countDocuments({ _id: formId, draftSchema: { $exists: true } })).toBe(0);
  });

  it("still rejects unknown field types and duplicate ids", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);

    expect((await save(tenant, formId, schemaOf({ ...dateField(), type: "DATETIME" }))).status).toBe(400);
    expect((await save(tenant, formId, schemaOf(dateField(), dateField()))).status).toBe(400);
  });

  it("publishes a DATE field and keeps the published schema immutable", async () => {
    const { tenant, formId } = await published(dateField({ minDate: "2020-01-01" }));

    const version = await FormVersion.findOne({ formId }).lean();
    expect(version?.schemaSnapshot).toEqual(schemaOf(dateField({ minDate: "2020-01-01" })));

    // Editing the draft afterwards does not change the published version.
    await save(tenant, formId, schemaOf(dateField({ minDate: "2025-01-01" })));
    expect((await FormVersion.findOne({ formId, version: 1 }).lean())?.schemaSnapshot).toEqual(
      schemaOf(dateField({ minDate: "2020-01-01" })),
    );
  });

  it("does not create a duplicate version for an unchanged DATE schema", async () => {
    const { tenant, formId } = await published(dateField());

    const again = await publish(tenant, formId);

    expect(again.status).toBe(409);
    expectStandardError(again.body as ErrorBody, "FORM_NO_CHANGES");
    expect(await FormVersion.countDocuments({ formId })).toBe(1);
  });
});

describe("DATE submissions", () => {
  it("accepts a valid date, stores the exact string, and works after publishing", async () => {
    const { tenant, formId } = await published(dateField());

    const res = await submit(tenant, formId, { birthday: "2026-02-28" });

    expect(res.status).toBe(201);
    const stored = await FormSubmission.findById(res.body.data.submission.id).lean();
    expect(stored?.data).toEqual({ birthday: "2026-02-28" });
    expect(typeof stored?.data.birthday).toBe("string");
  });

  it("accepts leap days and omitted optional dates, including empty", async () => {
    const { tenant, formId } = await published(dateField());

    expect((await submit(tenant, formId, { birthday: "2024-02-29" })).status).toBe(201);
    expect((await submit(tenant, formId, {})).status).toBe(201);
    expect((await submit(tenant, formId, { birthday: "" })).status).toBe(201);
  });

  it.each(["2026-99-99", "2026-02-31", "2025-02-29", "2026-13-01", "26-01-01", "2026-1-1", "01/02/2026", "tomorrow", "2026-01-01T10:00:00Z", " 2026-01-01"])(
    "rejects the invalid date %j",
    async (value) => {
      const { tenant, formId } = await published(dateField());

      const res = await submit(tenant, formId, { birthday: value });

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
      expect(res.body.error.fields.birthday).toMatch(/valid date/);
      expect(await FormSubmission.countDocuments({})).toBe(0);
    },
  );

  it.each([[20260101], [true], [{}], [["2026-01-01"]], [null]])(
    "rejects the non-string value %j",
    async (value) => {
      const { tenant, formId } = await published(dateField());

      const res = await submit(tenant, formId, { birthday: value });

      expect(res.status).toBe(400);
      expect(await FormSubmission.countDocuments({})).toBe(0);
    },
  );

  it("enforces required (missing and empty)", async () => {
    const { tenant, formId } = await published(dateField({}, { required: true }));

    for (const data of [{}, { birthday: "" }]) {
      const res = await submit(tenant, formId, data);
      expect(res.status).toBe(400);
      expect(res.body.error.fields.birthday).toMatch(/required/);
    }
    expect((await submit(tenant, formId, { birthday: "2026-01-01" })).status).toBe(201);
  });

  it("enforces minDate and maxDate inclusively", async () => {
    const { tenant, formId } = await published(
      dateField({ minDate: "2026-01-10", maxDate: "2026-01-20" }),
    );

    const early = await submit(tenant, formId, { birthday: "2026-01-09" });
    const late = await submit(tenant, formId, { birthday: "2026-01-21" });
    expect(early.status).toBe(400);
    expect(early.body.error.fields.birthday).toMatch(/on or after 2026-01-10/);
    expect(late.status).toBe(400);
    expect(late.body.error.fields.birthday).toMatch(/on or before 2026-01-20/);
    expect((await submit(tenant, formId, { birthday: "2026-01-10" })).status).toBe(201);
    expect((await submit(tenant, formId, { birthday: "2026-01-20" })).status).toBe(201);
    expect((await submit(tenant, formId, { birthday: "2026-01-15" })).status).toBe(201);
  });

  it("validates against the published version, not the draft", async () => {
    const { tenant, formId } = await published(dateField({ minDate: "2026-01-01" }));
    // The draft is relaxed but not republished.
    await save(tenant, formId, schemaOf(dateField({ minDate: "2000-01-01" })));

    const res = await submit(tenant, formId, { birthday: "2010-05-05" });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.birthday).toMatch(/on or after 2026-01-01/);
  });

  it("works next to the other field types, which are unchanged", async () => {
    const { tenant, formId } = await published(textField({ minLength: 3 }), dateField());

    expect((await submit(tenant, formId, { name: "Ada", birthday: "2026-03-04" })).status).toBe(201);
    const bad = await submit(tenant, formId, { name: "Al", birthday: "2026-02-30" });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields).sort()).toEqual(["birthday", "name"]);
  });
});
