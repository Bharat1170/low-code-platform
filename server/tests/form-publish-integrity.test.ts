import request from "supertest";
import { describe, expect, it } from "vitest";

import app from "../src/app.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { FormVersion } from "../src/models/form-version.model.js";
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
 * 8.17.13 hardening — publishing is only possible through
 * POST /api/forms/:id/publish. PATCH /api/forms/:id must never set
 * status = PUBLISHED, create a version or touch publishedVersionId.
 */

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

const draft = {
  version: 1,
  fields: [
    {
      id: "name_field",
      type: "TEXT",
      label: "Name",
      description: "",
      required: false,
      config: { placeholder: "", defaultValue: "" },
      validation: {},
      conditionalLogic: null,
    },
  ],
};

const patch = (tenant: Tenant, formId: string, body: unknown) =>
  request(app)
    .patch(`/api/forms/${formId}`)
    .set("Authorization", auth(tenant))
    .send(body as object);

const publish = (tenant: Tenant, formId: string) =>
  request(app)
    .post(`/api/forms/${formId}/publish`)
    .set("Authorization", auth(tenant));

const setup = async () => {
  const tenant = await createTenant();
  const created = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact Form",
      slug: "contact-form",
      status: "draft",
      projectId: tenant.projectId,
    });
  expect(created.status).toBe(201);
  const formId = created.body.data.form._id as string;
  expect((await patch(tenant, formId, { draftSchema: draft })).status).toBe(
    200,
  );
  return { tenant, formId };
};

describe("PATCH cannot publish", () => {
  it.each(["PUBLISHED", "published", "  Published  "])(
    "rejects status %j with 400 FORM_PUBLISH_REQUIRED",
    async (status) => {
      const { tenant, formId } = await setup();

      const res = await patch(tenant, formId, { status });

      expect(res.status).toBe(400);
      expectStandardError(res.body as ErrorBody, "FORM_PUBLISH_REQUIRED");
      expect(res.body.error.message).toMatch(/publish/i);
    },
  );

  it("creates no version, no audit event and changes nothing", async () => {
    const { tenant, formId } = await setup();
    const before = await Form.findById(formId).lean();
    const auditBefore = await AuditLog.countDocuments({});

    await patch(tenant, formId, { status: "PUBLISHED" });

    const after = await Form.findById(formId).lean();
    expect(after?.status).toBe("DRAFT");
    expect(after?.publishedVersionId).toBeUndefined();
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(await FormVersion.countDocuments({})).toBe(0);
    expect(await AuditLog.countDocuments({})).toBe(auditBefore);
  });

  it("rejects the whole request when other metadata is sent with it", async () => {
    const { tenant, formId } = await setup();

    const res = await patch(tenant, formId, {
      name: "Sneaky",
      status: "PUBLISHED",
    });

    expect(res.status).toBe(400);
    const stored = await Form.findById(formId).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.status).toBe("DRAFT");
  });

  it("leaves an already published form's version and status untouched", async () => {
    const { tenant, formId } = await setup();
    expect((await publish(tenant, formId)).status).toBe(200);
    const published = await Form.findById(formId).lean();
    const versions = await FormVersion.countDocuments({});

    const res = await patch(tenant, formId, { status: "PUBLISHED" });

    expect(res.status).toBe(400);
    const after = await Form.findById(formId).lean();
    expect(after?.status).toBe("PUBLISHED");
    expect(after?.publishedVersionId?.toString()).toBe(
      published?.publishedVersionId?.toString(),
    );
    expect(await FormVersion.countDocuments({})).toBe(versions);
  });

  it("cannot be used to bypass authentication or tenancy", async () => {
    const { formId } = await setup();
    const other = await createTenant();

    const unauthenticated = await request(app)
      .patch(`/api/forms/${formId}`)
      .send({ status: "PUBLISHED" });
    const foreign = await patch(other, formId, { status: "PUBLISHED" });

    expect(unauthenticated.status).toBe(401);
    expect(foreign.status).toBe(404);
    expectStandardError(foreign.body as ErrorBody, "FORM_NOT_FOUND");
    expect((await Form.findById(formId).lean())?.status).toBe("DRAFT");
    expect(await FormVersion.countDocuments({})).toBe(0);
  });
});

describe("legitimate updates still work", () => {
  it("updates metadata", async () => {
    const { tenant, formId } = await setup();

    const res = await patch(tenant, formId, {
      name: "Renamed",
      description: "New description",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.form).toMatchObject({
      name: "Renamed",
      description: "New description",
      status: "DRAFT",
    });
  });

  it("archives and returns a form to draft", async () => {
    const { tenant, formId } = await setup();

    const archived = await patch(tenant, formId, { status: "archived" });
    const back = await patch(tenant, formId, { status: "draft" });

    expect(archived.status).toBe(200);
    expect(archived.body.data.form.status).toBe("ARCHIVED");
    expect(back.status).toBe(200);
    expect(back.body.data.form.status).toBe("DRAFT");
  });

  it("still saves drafts", async () => {
    const { tenant, formId } = await setup();

    const res = await patch(tenant, formId, {
      draftSchema: { version: 1, fields: [] },
    });

    expect(res.status).toBe(200);
  });

  it("the publish endpoint still publishes, and not twice for one draft", async () => {
    const { tenant, formId } = await setup();

    const first = await publish(tenant, formId);
    const second = await publish(tenant, formId);

    expect(first.status).toBe(200);
    // An unchanged draft is refused (409) instead of creating a version.
    expect(second.status).toBe(409);
    expect(await FormVersion.countDocuments({})).toBe(1);
    expect((await Form.findById(formId).lean())?.status).toBe("PUBLISHED");
  });
});
