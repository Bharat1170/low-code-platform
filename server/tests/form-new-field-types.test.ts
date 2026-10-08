import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { FormSubmission } from "../src/models/form-submission.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { csvCell } from "../src/utils/csv.util.js";

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
 * TEXTAREA, NUMBER, PHONE, URL, RADIO, MULTI_SELECT and RATING: draft
 * validation, publish rules, server-side submission validation, and the
 * CSV export of submissions.
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
  return { user, session: await createTestSession(user), projectId: project._id.toString() };
};

const auth = (tenant: Tenant) => bearer(tenant.session.accessToken);

const base = (id: string, type: string, label: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type,
  label,
  description: "",
  required: false,
  validation: {},
  conditionalLogic: null,
  ...overrides,
});

const options = (...values: string[]) => values.map((value) => ({ label: value.toUpperCase(), value }));

const bio = base("bio", "TEXTAREA", "Bio", {
  config: { placeholder: "", defaultValue: "" },
  validation: { maxLength: 20 },
});
const age = base("age", "NUMBER", "Age", {
  config: { placeholder: "", defaultValue: "" },
  validation: { min: 18, max: 120, integer: true },
});
const phone = base("phone", "PHONE", "Phone", { config: { placeholder: "", defaultValue: "" } });
const site = base("site", "URL", "Website", { config: { placeholder: "", defaultValue: "" } });
const size = base("size", "RADIO", "Size", {
  required: true,
  config: { options: options("s", "m", "l"), defaultValue: "" },
});
const toppings = base("toppings", "MULTI_SELECT", "Toppings", {
  config: { options: options("ham", "olive", "corn"), defaultValue: [] },
  validation: { max: 2 },
});
const stars = base("stars", "RATING", "Rating", {
  required: true,
  config: { max: 5, defaultValue: 0 },
});

const schema = (...fields: unknown[]) => ({ version: 1, fields });
const allFields = () => schema(bio, age, phone, site, size, toppings, stars);

let counter = 0;
const createForm = async (tenant: Tenant, name = "Order"): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({ name, slug: `field-types-${counter}`, status: "draft", projectId: tenant.projectId });
  expect(res.status).toBe(201);
  return res.body.data.form._id as string;
};

const save = (tenant: Tenant, formId: string, draft: unknown) =>
  request(app).patch(`/api/forms/${formId}`).set("Authorization", auth(tenant)).send({ draftSchema: draft });

const publish = (tenant: Tenant, formId: string) =>
  request(app).post(`/api/forms/${formId}/publish`).set("Authorization", auth(tenant));

const submit = (tenant: Tenant, formId: string, data: unknown) =>
  request(app).post(`/api/forms/${formId}/submissions`).set("Authorization", auth(tenant)).send({ data });

const setup = async () => {
  const tenant = await createTenant();
  const formId = await createForm(tenant);
  expect((await save(tenant, formId, allFields())).status).toBe(200);
  expect((await publish(tenant, formId)).status).toBe(200);
  return { tenant, formId };
};

const valid = {
  bio: "Hello",
  age: "30",
  phone: "+91 98765 43210",
  site: "https://example.com/me",
  size: "m",
  toppings: ["ham", "corn"],
  stars: "4",
};

describe("draft validation of the new field types", () => {
  it("accepts a draft with every new type", async () => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    expect((await save(tenant, formId, allFields())).status).toBe(200);
  });

  it.each([
    ["a non-numeric NUMBER default", schema({ ...age, config: { placeholder: "", defaultValue: "abc" } })],
    ["a NUMBER default outside min/max", schema({ ...age, config: { placeholder: "", defaultValue: "5" } })],
    ["integer on a TEXT field", schema(base("t", "TEXT", "T", { config: { placeholder: "", defaultValue: "" }, validation: { integer: true } }))],
    ["a RADIO default that is not an option", schema({ ...size, config: { options: options("s"), defaultValue: "x" } })],
    ["duplicate MULTI_SELECT options", schema({ ...toppings, config: { options: options("a", "a"), defaultValue: [] } })],
    ["a MULTI_SELECT default that is not an option", schema({ ...toppings, config: { options: options("a"), defaultValue: ["b"] } })],
    ["a RATING scale above 10", schema({ ...stars, config: { max: 11, defaultValue: 0 } })],
    ["a RATING default above its scale", schema({ ...stars, config: { max: 5, defaultValue: 6 } })],
    ["a RADIO with a placeholder key", schema({ ...size, config: { options: options("s"), defaultValue: "", placeholder: "" } })],
  ])("rejects %s", async (_name, draft) => {
    const tenant = await createTenant();
    const formId = await createForm(tenant);
    const res = await save(tenant, formId, draft);
    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
  });

  it("does not publish RADIO or MULTI_SELECT without options", async () => {
    for (const field of [
      { ...size, config: { options: [], defaultValue: "" } },
      { ...toppings, config: { options: [], defaultValue: [] } },
    ]) {
      const tenant = await createTenant();
      const formId = await createForm(tenant);
      expect((await save(tenant, formId, schema(field))).status).toBe(200);
      const res = await publish(tenant, formId);
      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "FORM_SCHEMA_INVALID");
    }
  });
});

describe("submission validation of the new field types", () => {
  it("stores valid values, including a multi-select list", async () => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, valid);

    expect(res.status).toBe(201);
    const stored = await FormSubmission.findOne({ formId }).lean();
    expect(stored?.data).toEqual(valid);
  });

  it.each([
    ["bio", "x".repeat(21)],
    ["age", "17"],
    ["age", "30.5"],
    ["age", "thirty"],
    ["phone", "12345"],
    ["phone", "call me"],
    ["site", "javascript:alert(1)"],
    ["site", "example.com"],
    ["size", "xl"],
    ["size", ""],
    ["toppings", ["ham", "olive", "corn"]],
    ["toppings", ["pineapple"]],
    ["toppings", ["ham", "ham"]],
    ["toppings", "ham"],
    ["toppings", [{ $ne: null }]],
    ["stars", "6"],
    ["stars", "0"],
    ["stars", ""],
  ])("rejects %s = %j", async (fieldId, value) => {
    const { tenant, formId } = await setup();

    const res = await submit(tenant, formId, { ...valid, [fieldId]: value });

    expect(res.status).toBe(400);
    expectStandardError(res.body as ErrorBody, "VALIDATION_ERROR");
    expect(Object.keys(res.body.error.fields).join(",")).toContain(fieldId);
    expect(await FormSubmission.countDocuments()).toBe(0);
  });
});

describe("GET /api/forms/:id/submissions/export", () => {
  it("returns a CSV with labelled columns, newest first, safe against formulas", async () => {
    const { tenant, formId } = await setup();
    expect((await submit(tenant, formId, { ...valid, bio: "=HYPERLINK(\"x\")" })).status).toBe(201);
    expect((await submit(tenant, formId, { ...valid, bio: "Line, two" })).status).toBe(201);

    const res = await request(app)
      .get(`/api/forms/${formId}/submissions/export`)
      .set("Authorization", auth(tenant));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="order-submissions.csv"');
    expect(res.headers["x-export-truncated"]).toBe("false");

    const lines = res.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Submitted at,Version,Submitted by,Bio,Age,Phone,Website,Size,Toppings,Rating");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Line, two"');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(lines[1]).toContain("ham; corn");
  });

  it("is tenant-scoped and permission-checked", async () => {
    const { formId } = await setup();
    const other = await createTenant();
    const noRead = await createTenant([]);

    const cross = await request(app)
      .get(`/api/forms/${formId}/submissions/export`)
      .set("Authorization", auth(other));
    expect(cross.status).toBe(404);

    const forbidden = await request(app)
      .get(`/api/forms/${formId}/submissions/export`)
      .set("Authorization", auth(noRead));
    expect(forbidden.status).toBe(403);

    expect((await request(app).get(`/api/forms/${formId}/submissions/export`)).status).toBe(401);
  });

  it("escapes formula-like and delimiter characters", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });
});

describe("access tokens are bound to their session", () => {
  it("rejects the access token after logout", async () => {
    const tenant = await createTenant();

    expect(
      (await request(app).get("/api/forms").set("Authorization", auth(tenant))).status,
    ).toBe(200);

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${tenant.session.refreshToken}`);
    expect(logout.status).toBe(200);

    const after = await request(app).get("/api/forms").set("Authorization", auth(tenant));
    expect(after.status).toBe(401);
    expectStandardError(after.body as ErrorBody, "UNAUTHORIZED");
  });
});
