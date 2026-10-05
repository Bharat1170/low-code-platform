import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";

import { Form } from "../src/models/form.model.js";
import { Project } from "../src/models/project.model.js";
import {
  createForm,
  deleteForm,
  getFormById,
  getFormBySlug,
  listForms,
  updateForm,
  type UpdateFormServiceInput,
} from "../src/services/form.service.js";
import type { AuthContext } from "../src/types/auth.types.js";
import {
  createFormSchema,
  updateFormSchema,
  type CreateFormInput,
} from "../src/validators/form.validator.js";

/*
 * 8.17.4 — Form service tests. The service runs against the real test
 * database (no mocks), like the Project tests. As in the Project
 * service, request validation happens at the controller boundary, so
 * the service receives already-validated input.
 */

const newId = (): mongoose.Types.ObjectId =>
  new mongoose.Types.ObjectId();

interface Tenant {
  auth: AuthContext;
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
}

const makeTenant = (): Tenant => {
  const organizationId = newId();
  const userId = newId();

  return {
    organizationId,
    userId,
    auth: {
      userId: userId.toString(),
      organizationId: organizationId.toString(),
      sessionId: newId().toString(),
    },
  };
};

const makeProject = async (
  tenant: Tenant,
  slug = `project-${newId().toString()}`,
) => {
  return Project.create({
    organizationId: tenant.organizationId,
    createdBy: tenant.userId,
    name: "Project",
    slug,
    status: "ACTIVE",
  });
};

const formInput = (
  projectId: mongoose.Types.ObjectId,
  overrides: Partial<CreateFormInput> = {},
): CreateFormInput => ({
  name: "Contact Form",
  description: "Collects contact details",
  slug: "contact-form",
  status: "DRAFT",
  projectId: projectId.toString(),
  ...overrides,
});

const untyped = <T>(value: unknown): T => value as T;

beforeAll(async () => {
  await Form.init();
  await Project.init();
});

describe("createForm", () => {
  it("creates a form in the authenticated organization and project", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);

    const form = await createForm(tenant.auth, formInput(project._id));

    expect(form).toMatchObject({
      name: "Contact Form",
      description: "Collects contact details",
      slug: "contact-form",
      status: "DRAFT",
    });
    expect(form.projectId.toString()).toBe(project._id.toString());

    const stored = await Form.findById(form._id).lean();
    expect(stored?.organizationId.toString()).toBe(
      tenant.auth.organizationId,
    );
  });

  it("uses the authenticated userId as createdBy", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);

    const form = await createForm(tenant.auth, formInput(project._id));

    expect(form.createdBy.toString()).toBe(tenant.auth.userId);
    expect(form.updatedBy).toBeUndefined();
  });

  it("defaults description to an empty string when omitted", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    const input = formInput(project._id);
    delete input.description;

    const form = await createForm(tenant.auth, input);

    expect(form.description).toBe("");
  });

  it("ignores a client-supplied organizationId and createdBy", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    const attackerOrg = newId();
    const attackerUser = newId();

    const form = await createForm(
      tenant.auth,
      untyped<CreateFormInput>({
        ...formInput(project._id),
        organizationId: attackerOrg.toString(),
        createdBy: attackerUser.toString(),
      }),
    );

    expect(form.organizationId.toString()).toBe(tenant.auth.organizationId);
    expect(form.createdBy.toString()).toBe(tenant.auth.userId);
    expect(
      await Form.countDocuments({ organizationId: attackerOrg }),
    ).toBe(0);
  });

  it("fails with PROJECT_NOT_FOUND when the project does not exist", async () => {
    const tenant = makeTenant();

    await expect(
      createForm(tenant.auth, formInput(newId())),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PROJECT_NOT_FOUND",
    });
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("fails with PROJECT_NOT_FOUND when the project belongs to another organization", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);

    await expect(
      createForm(tenantA.auth, formInput(projectB._id)),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PROJECT_NOT_FOUND",
    });
    expect(await Form.countDocuments({})).toBe(0);
  });

  it("gives the same error for a foreign project as for a missing one", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);

    const foreign = await createForm(
      tenantA.auth,
      formInput(projectB._id),
    ).catch((error: unknown) => error);
    const missing = await createForm(
      tenantA.auth,
      formInput(newId()),
    ).catch((error: unknown) => error);

    expect(foreign).toMatchObject({
      statusCode: 404,
      code: "PROJECT_NOT_FOUND",
      message: (missing as Error).message,
    });
  });

  it("propagates the duplicate-key error for a duplicate slug", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);

    await createForm(tenant.auth, formInput(project._id));

    await expect(
      createForm(tenant.auth, formInput(project._id)),
    ).rejects.toMatchObject({ code: 11000 });
    expect(
      await Form.countDocuments({ organizationId: tenant.organizationId }),
    ).toBe(1);
  });

  it("allows the same slug in different organizations", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectA = await makeProject(tenantA);
    const projectB = await makeProject(tenantB);

    await createForm(tenantA.auth, formInput(projectA._id));
    await expect(
      createForm(tenantB.auth, formInput(projectB._id)),
    ).resolves.toBeDefined();
  });

  it("rejects an operator object as projectId without creating a form", async () => {
    const tenant = makeTenant();
    await makeProject(tenant);

    await expect(
      createForm(
        tenant.auth,
        untyped<CreateFormInput>({
          ...formInput(newId()),
          projectId: { $ne: null },
        }),
      ),
    ).rejects.toThrow();
    expect(await Form.countDocuments({})).toBe(0);
  });
});

describe("validation happens before the service", () => {
  it("createFormSchema rejects protected fields and operators, so the service is never reached", () => {
    const base = formInput(newId());

    for (const body of [
      { ...base, organizationId: newId().toString() },
      { ...base, createdBy: newId().toString() },
      { ...base, $where: "1==1" },
      { ...base, projectId: { $ne: null } },
      { ...base, name: { $ne: "" } },
    ]) {
      expect(createFormSchema.safeParse(body).success).toBe(false);
    }
  });

  it("updateFormSchema rejects protected fields, operators and empty updates", () => {
    for (const body of [
      {},
      { organizationId: newId().toString() },
      { createdBy: newId().toString() },
      { _id: newId().toString() },
      { $set: { organizationId: "x" } },
      { status: { $gt: "" } },
    ]) {
      expect(updateFormSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("listForms", () => {
  it("lists only the authenticated organization's forms", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectA = await makeProject(tenantA);
    const projectB = await makeProject(tenantB);

    await createForm(tenantA.auth, formInput(projectA._id, { slug: "a-1" }));
    await createForm(tenantA.auth, formInput(projectA._id, { slug: "a-2" }));
    await createForm(tenantB.auth, formInput(projectB._id, { slug: "b-1" }));

    const forms = await listForms(tenantA.auth);

    expect(forms.map((f) => f.slug).sort()).toEqual(["a-1", "a-2"]);
  });

  it("filters by a project of the same organization", async () => {
    const tenant = makeTenant();
    const project1 = await makeProject(tenant);
    const project2 = await makeProject(tenant);

    await createForm(tenant.auth, formInput(project1._id, { slug: "in-1" }));
    await createForm(tenant.auth, formInput(project2._id, { slug: "in-2" }));

    const forms = await listForms(tenant.auth, {
      projectId: project1._id.toString(),
    });

    expect(forms.map((f) => f.slug)).toEqual(["in-1"]);
  });

  it("fails with PROJECT_NOT_FOUND for another organization's projectId", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);
    await createForm(tenantB.auth, formInput(projectB._id));

    await expect(
      listForms(tenantA.auth, { projectId: projectB._id.toString() }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("respects limit, skip and the maximum limit of 100", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    await Form.insertMany(
      Array.from({ length: 105 }, (_, i) => ({
        organizationId: tenant.organizationId,
        projectId: project._id,
        name: `Bulk ${i}`,
        slug: `bulk-${i}`,
        status: "DRAFT",
        createdBy: tenant.userId,
      })),
    );

    expect(await listForms(tenant.auth)).toHaveLength(20);
    expect(await listForms(tenant.auth, { limit: 5 })).toHaveLength(5);
    expect(
      await listForms(tenant.auth, { limit: 5, skip: 103 }),
    ).toHaveLength(2);
    expect(await listForms(tenant.auth, { limit: 100000 })).toHaveLength(
      100,
    );
  });
});

describe("getFormById and getFormBySlug", () => {
  it("gets a form of the same organization by ID", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    const created = await createForm(tenant.auth, formInput(project._id));

    const form = await getFormById(tenant.auth, created._id.toString());

    expect(form._id.toString()).toBe(created._id.toString());
  });

  it("throws FORM_NOT_FOUND for another organization's form and for a missing one", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);
    const formB = await createForm(tenantB.auth, formInput(projectB._id));

    const foreign = await getFormById(
      tenantA.auth,
      formB._id.toString(),
    ).catch((error: unknown) => error);
    const missing = await getFormById(
      tenantA.auth,
      newId().toString(),
    ).catch((error: unknown) => error);

    expect(foreign).toMatchObject({
      statusCode: 404,
      code: "FORM_NOT_FOUND",
    });
    expect(missing).toMatchObject({
      statusCode: 404,
      code: "FORM_NOT_FOUND",
      message: (foreign as Error).message,
    });
  });

  it("gets a form by slug within the organization only", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectA = await makeProject(tenantA);
    const projectB = await makeProject(tenantB);
    const formA = await createForm(tenantA.auth, formInput(projectA._id));
    const formB = await createForm(tenantB.auth, formInput(projectB._id));

    const foundA = await getFormBySlug(tenantA.auth, "contact-form");
    const foundB = await getFormBySlug(tenantB.auth, "contact-form");

    expect(foundA._id.toString()).toBe(formA._id.toString());
    expect(foundB._id.toString()).toBe(formB._id.toString());
  });

  it("throws FORM_NOT_FOUND for a slug that only exists in another organization", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);
    await createForm(tenantB.auth, formInput(projectB._id));

    await expect(
      getFormBySlug(tenantA.auth, "contact-form"),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });
});

describe("updateForm", () => {
  const setup = async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    const form = await createForm(tenant.auth, formInput(project._id));
    return { tenant, project, form };
  };

  it("updates the form", async () => {
    const { tenant, form } = await setup();

    const updated = await updateForm(tenant.auth, form._id.toString(), {
      name: "Renamed",
      description: "New",
      slug: "renamed",
      status: "ARCHIVED",
    });

    expect(updated).toMatchObject({
      name: "Renamed",
      description: "New",
      slug: "renamed",
      status: "ARCHIVED",
    });
  });

  it("sets updatedBy to the authenticated user", async () => {
    const { tenant, form } = await setup();

    const updated = await updateForm(tenant.auth, form._id.toString(), {
      name: "Renamed",
    });

    expect(updated.updatedBy?.toString()).toBe(tenant.auth.userId);
    expect(
      (await Form.findById(form._id).lean())?.updatedBy?.toString(),
    ).toBe(tenant.auth.userId);
  });

  it("cannot change organizationId, createdBy or _id", async () => {
    const { tenant, form } = await setup();
    const forgedId = newId();

    const updated = await updateForm(
      tenant.auth,
      form._id.toString(),
      untyped<UpdateFormServiceInput>({
        name: "Changed",
        organizationId: newId().toString(),
        createdBy: newId().toString(),
        _id: forgedId.toString(),
        updatedBy: newId().toString(),
      }),
    );

    expect(updated.name).toBe("Changed");
    expect(updated._id.toString()).toBe(form._id.toString());
    expect(updated.organizationId.toString()).toBe(
      tenant.auth.organizationId,
    );
    expect(updated.createdBy.toString()).toBe(tenant.auth.userId);
    // updatedBy is always the authenticated user, never the payload.
    expect(updated.updatedBy?.toString()).toBe(tenant.auth.userId);
    expect(await Form.countDocuments({ _id: forgedId })).toBe(0);
  });

  it("moves the form to another project of the same organization", async () => {
    const { tenant, form } = await setup();
    const other = await makeProject(tenant);

    const updated = await updateForm(tenant.auth, form._id.toString(), {
      projectId: other._id.toString(),
    });

    expect(updated.projectId.toString()).toBe(other._id.toString());
  });

  it("rejects moving the form to another organization's project", async () => {
    const { tenant, form, project } = await setup();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);

    await expect(
      updateForm(tenant.auth, form._id.toString(), {
        projectId: projectB._id.toString(),
      }),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const stored = await Form.findById(form._id).lean();
    expect(stored?.projectId.toString()).toBe(project._id.toString());
    expect(stored?.updatedBy).toBeUndefined();
  });

  it("does not look up the project when projectId is not updated", async () => {
    const tenant = makeTenant();
    // A form whose project no longer exists: only a project lookup would
    // make a name-only update fail.
    const orphan = await Form.create({
      organizationId: tenant.organizationId,
      projectId: newId(),
      name: "Orphan",
      slug: "orphan",
      status: "DRAFT",
      createdBy: tenant.userId,
    });

    const updated = await updateForm(tenant.auth, orphan._id.toString(), {
      name: "Still works",
    });

    expect(updated.name).toBe("Still works");
  });

  it("supports currentDraftVersionId and publishedVersionId from trusted callers", async () => {
    const { tenant, form } = await setup();
    const draft = newId();
    const published = newId();

    const updated = await updateForm(tenant.auth, form._id.toString(), {
      currentDraftVersionId: draft,
      publishedVersionId: published,
    });

    expect(updated.currentDraftVersionId?.toString()).toBe(draft.toString());
    expect(updated.publishedVersionId?.toString()).toBe(
      published.toString(),
    );
  });

  it("throws FORM_NOT_FOUND and changes nothing for another organization's form", async () => {
    const { form } = await setup();
    const tenantB = makeTenant();

    await expect(
      updateForm(tenantB.auth, form._id.toString(), { name: "Hijacked" }),
    ).rejects.toMatchObject({ statusCode: 404, code: "FORM_NOT_FOUND" });

    const stored = await Form.findById(form._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.updatedBy).toBeUndefined();
  });

  it("throws FORM_NOT_FOUND for a missing form", async () => {
    const tenant = makeTenant();

    await expect(
      updateForm(tenant.auth, newId().toString(), { name: "x" }),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });

  it("propagates the duplicate-key error when the slug collides", async () => {
    const { tenant, project, form } = await setup();
    await createForm(
      tenant.auth,
      formInput(project._id, { slug: "taken" }),
    );

    await expect(
      updateForm(tenant.auth, form._id.toString(), { slug: "taken" }),
    ).rejects.toMatchObject({ code: 11000 });
    expect((await Form.findById(form._id).lean())?.slug).toBe(
      "contact-form",
    );
  });

  it("does not execute operator payloads", async () => {
    const { tenant, form } = await setup();

    await expect(
      updateForm(
        tenant.auth,
        form._id.toString(),
        untyped<UpdateFormServiceInput>({ projectId: { $ne: null } }),
      ),
    ).rejects.toThrow();
    await expect(
      updateForm(
        tenant.auth,
        form._id.toString(),
        untyped<UpdateFormServiceInput>({ name: { $ne: "" } }),
      ),
    ).rejects.toThrow();

    const stored = await Form.findById(form._id).lean();
    expect(stored?.name).toBe("Contact Form");
    expect(stored?.organizationId.toString()).toBe(
      tenant.auth.organizationId,
    );
  });
});

describe("deleteForm", () => {
  it("deletes a form of the same organization", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    const form = await createForm(tenant.auth, formInput(project._id));

    await expect(
      deleteForm(tenant.auth, form._id.toString()),
    ).resolves.toBeUndefined();

    expect(await Form.countDocuments({ _id: form._id })).toBe(0);
    await expect(
      getFormById(tenant.auth, form._id.toString()),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });

  it("cannot delete another organization's form", async () => {
    const tenantA = makeTenant();
    const tenantB = makeTenant();
    const projectB = await makeProject(tenantB);
    const formB = await createForm(tenantB.auth, formInput(projectB._id));

    await expect(
      deleteForm(tenantA.auth, formB._id.toString()),
    ).rejects.toMatchObject({ statusCode: 404, code: "FORM_NOT_FOUND" });
    expect(await Form.countDocuments({ _id: formB._id })).toBe(1);
  });

  it("throws FORM_NOT_FOUND for a missing form and on a second delete", async () => {
    const tenant = makeTenant();
    const project = await makeProject(tenant);
    const form = await createForm(tenant.auth, formInput(project._id));

    await deleteForm(tenant.auth, form._id.toString());

    await expect(
      deleteForm(tenant.auth, form._id.toString()),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
    await expect(
      deleteForm(tenant.auth, newId().toString()),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });
});
