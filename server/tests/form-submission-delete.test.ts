import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import { AUDIT_ACTIONS } from "../src/constants/audit-actions.js";
import { PERMISSIONS } from "../src/constants/permissions.js";
import { OWNER_PERMISSIONS, ROLE_NAMES } from "../src/constants/roles.js";
import { AuditLog } from "../src/models/audit-log.model.js";
import { FormSubmission } from "../src/models/form-submission.model.js";
import { Project } from "../src/models/project.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import * as auditRepository from "../src/repositories/audit-log.repository.js";

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
 * DELETE /api/forms/:id/submissions/:submissionId
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

let counter = 0;

const createForm = async (tenant: Tenant): Promise<string> => {
  counter += 1;
  const res = await request(app)
    .post("/api/forms")
    .set("Authorization", auth(tenant))
    .send({
      name: "Contact",
      slug: `delete-form-${counter}`,
      status: "draft",
      projectId: tenant.projectId,
    });
  expect(res.status).toBe(201);
  return res.body.data.form._id as string;
};

const setup = async (permissions?: readonly string[]) => {
  const tenant = await createTenant(permissions);
  const formId = await createForm(tenant);
  expect(
    (
      await request(app)
        .patch(`/api/forms/${formId}`)
        .set("Authorization", auth(tenant))
        .send({
          draftSchema: { version: 1, fields: [textField("name", "Name")] },
        })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(app)
        .post(`/api/forms/${formId}/publish`)
        .set("Authorization", auth(tenant))
    ).status,
  ).toBe(200);
  return { tenant, formId };
};

const submit = async (
  tenant: Tenant,
  formId: string,
  name = "secret-value",
): Promise<string> => {
  const res = await request(app)
    .post(`/api/forms/${formId}/submissions`)
    .set("Authorization", auth(tenant))
    .send({ data: { name } });
  expect(res.status).toBe(201);
  return res.body.data.submission.id as string;
};

const remove = (tenant: Tenant, formId: string, submissionId: string) =>
  request(app)
    .delete(`/api/forms/${formId}/submissions/${submissionId}`)
    .set("Authorization", auth(tenant));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleting a submission", () => {
  it("deletes the submission and writes one audit event with identifiers only", async () => {
    const { tenant, formId } = await setup();
    const keep = await submit(tenant, formId, "keep");
    const target = await submit(tenant, formId);

    const res = await remove(tenant, formId, target);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await FormSubmission.findById(target)).toBeNull();
    expect(await FormSubmission.findById(keep)).not.toBeNull();

    const audits = await AuditLog.find({
      action: AUDIT_ACTIONS.SUBMISSION_DELETED,
    }).lean();
    expect(audits).toHaveLength(1);
    expect(String(audits[0].resourceId)).toBe(target);
    expect(String(audits[0].userId)).toBe(tenant.user.userId);
    expect(JSON.stringify(audits[0])).not.toContain("secret-value");
  });

  it("returns 404 when the same submission is deleted twice", async () => {
    const { tenant, formId } = await setup();
    const target = await submit(tenant, formId);

    expect((await remove(tenant, formId, target)).status).toBe(200);
    const again = await remove(tenant, formId, target);

    expect(again.status).toBe(404);
    expectStandardError(again.body as ErrorBody, "SUBMISSION_NOT_FOUND");
    expect(
      await AuditLog.countDocuments({
        action: AUDIT_ACTIONS.SUBMISSION_DELETED,
      }),
    ).toBe(1);
  });

  it("returns 404 for a random submission id and 400 for malformed ids", async () => {
    const { tenant, formId } = await setup();

    const missing = await remove(tenant, formId, objectId());
    expect(missing.status).toBe(404);
    expectStandardError(missing.body as ErrorBody, "SUBMISSION_NOT_FOUND");

    expect((await remove(tenant, formId, "not-an-id")).status).toBe(400);
    expect((await remove(tenant, "not-an-id", objectId())).status).toBe(400);
  });
});

describe("authentication and authorization", () => {
  it("returns 401 when unauthenticated and deletes nothing", async () => {
    const { tenant, formId } = await setup();
    const target = await submit(tenant, formId);

    const res = await request(app).delete(
      `/api/forms/${formId}/submissions/${target}`,
    );

    expect(res.status).toBe(401);
    expect(await FormSubmission.findById(target)).not.toBeNull();
  });

  it("returns 403 without submission.delete, even with read and create", async () => {
    const withoutDelete = OWNER_PERMISSIONS.filter(
      (permission) => permission !== PERMISSIONS.SUBMISSION_DELETE,
    );
    const { tenant, formId } = await setup(withoutDelete);
    const target = await submit(tenant, formId);

    const res = await remove(tenant, formId, target);

    expect(res.status).toBe(403);
    expect(await FormSubmission.findById(target)).not.toBeNull();
    expect(
      await AuditLog.countDocuments({
        action: AUDIT_ACTIONS.SUBMISSION_DELETED,
      }),
    ).toBe(0);
  });

  it("allows deletion with submission.delete and no submission.read", async () => {
    const { tenant, formId } = await setup(
      OWNER_PERMISSIONS.filter(
        (permission) => permission !== PERMISSIONS.SUBMISSION_READ,
      ),
    );
    const target = await submit(tenant, formId);

    expect((await remove(tenant, formId, target)).status).toBe(200);
  });
});

describe("tenant isolation", () => {
  it("returns 404 for another tenant's form and leaves the submission intact", async () => {
    const a = await setup();
    const b = await setup();
    const submissionB = await submit(b.tenant, b.formId);

    const res = await remove(a.tenant, b.formId, submissionB);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "FORM_NOT_FOUND");
    expect(await FormSubmission.findById(submissionB)).not.toBeNull();
  });

  it("returns 404 for another tenant's submission id under the caller's own form", async () => {
    const a = await setup();
    const b = await setup();
    const submissionB = await submit(b.tenant, b.formId);

    const res = await remove(a.tenant, a.formId, submissionB);

    expect(res.status).toBe(404);
    expectStandardError(res.body as ErrorBody, "SUBMISSION_NOT_FOUND");
    expect(await FormSubmission.findById(submissionB)).not.toBeNull();
  });

  it("returns 404 for a submission of a different form of the same tenant", async () => {
    const { tenant, formId } = await setup();
    const otherFormId = await createForm(tenant);
    const target = await submit(tenant, formId);

    const res = await remove(tenant, otherFormId, target);

    expect(res.status).toBe(404);
    expect(await FormSubmission.findById(target)).not.toBeNull();
  });

  it("ignores a forged organizationId in the query and body", async () => {
    const a = await setup();
    const b = await setup();
    const submissionB = await submit(b.tenant, b.formId);

    const res = await request(app)
      .delete(
        `/api/forms/${a.formId}/submissions/${submissionB}?organizationId=${b.tenant.user.organizationId}`,
      )
      .set("Authorization", auth(a.tenant))
      .send({ organizationId: b.tenant.user.organizationId });

    expect(res.status).toBe(404);
    expect(await FormSubmission.findById(submissionB)).not.toBeNull();
  });
});

describe("atomicity", () => {
  it("keeps the submission if the audit event cannot be written", async () => {
    const { tenant, formId } = await setup();
    const target = await submit(tenant, formId);

    vi.spyOn(auditRepository, "createAuditLog").mockRejectedValueOnce(
      new Error("audit failure"),
    );

    const res = await remove(tenant, formId, target);

    expect(res.status).toBe(500);
    expect(await FormSubmission.findById(target)).not.toBeNull();
  });
});
