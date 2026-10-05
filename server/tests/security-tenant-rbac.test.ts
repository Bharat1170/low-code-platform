import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  type Permission,
} from "../src/constants/permissions.js";
import {
  OWNER_PERMISSIONS,
  ROLE_NAMES,
  type RoleName,
} from "../src/constants/roles.js";
import { authenticate } from "../src/middleware/auth.middleware.js";
import {
  requireActiveAccount,
  requirePermission,
} from "../src/middleware/authorization.middleware.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { findRolesByIdsForOrganization } from "../src/repositories/role.repository.js";
import { sendSuccess } from "../src/utils/response.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  type TestSession,
  type TestUser,
} from "./helpers.js";
import {
  expectNoInternals,
  expectStandardError,
  type ErrorBody,
} from "./security-helpers.js";

/*
 * 8.15.11 / 3 and 4 - Tenant isolation and RBAC.
 *
 * There are no user, role or project endpoints yet (the only
 * tenant-owned resources with routes are sessions, covered in
 * session-isolation.test.ts). RBAC is therefore exercised on a
 * test-only app that mirrors the intended wiring, and the tenant filter
 * is tested directly at the repository that resolves roles.
 */

const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

const testApp = express();
testApp.use(express.json());

const echo: express.RequestHandler = (req, res) => {
  sendSuccess(res, 200, "ok", {
    userId: req.account?.userId,
    organizationId: req.account?.organizationId,
  });
};

testApp.get("/active", authenticate, requireActiveAccount, echo);

for (const permission of ALL_PERMISSIONS) {
  testApp.post(
    `/guarded/${permission}`,
    authenticate,
    requirePermission(permission),
    echo,
  );
}

testApp.use(errorHandler);

const ROLE_NAME_LIST = Object.values(ROLE_NAMES);

const createRole = (
  organizationId: string,
  name: RoleName,
  permissions: readonly string[],
) =>
  Role.create({
    organizationId,
    name,
    description: "",
    permissions: [...permissions],
  });

const assignRoles = (
  user: TestUser,
  roleIds: mongoose.Types.ObjectId[],
) =>
  User.updateOne({ _id: user.userId }, { $set: { roleIds } });

const attempt = (permission: string, session: TestSession) =>
  request(testApp)
    .post(`/guarded/${permission}`)
    .set("Authorization", bearer(session.accessToken));

const setup = async (
  permissions: readonly string[],
  name: RoleName = ROLE_NAMES.BUILDER,
) => {
  const user = await createTestUser();
  const role = await createRole(user.organizationId, name, permissions);
  await assignRoles(user, [role._id]);
  const session = await createTestSession(user);

  return { user, role, session };
};

describe("permission semantics", () => {
  it("OWNER_PERMISSIONS is exactly the set of every defined permission", () => {
    expect([...OWNER_PERMISSIONS].sort()).toEqual(
      [...ALL_PERMISSIONS].sort(),
    );
  });

  it("an OWNER role passes every permission guard", async () => {
    const { session } = await setup(OWNER_PERMISSIONS, ROLE_NAMES.OWNER);

    for (const permission of ALL_PERMISSIONS) {
      expect((await attempt(permission, session)).status, permission).toBe(
        200,
      );
    }
  });

  it("a role holding exactly one permission passes only that guard", async () => {
    const { role, session } = await setup([]);

    for (const granted of ALL_PERMISSIONS) {
      await Role.updateOne(
        { _id: role._id },
        { $set: { permissions: [granted] } },
      );

      for (const guarded of ALL_PERMISSIONS) {
        const res = await attempt(guarded, session);

        expect(
          res.status,
          `holds ${granted}, guarded ${guarded}`,
        ).toBe(granted === guarded ? 200 : 403);
      }
    }
  });

  it("matches permission strings exactly (no prefix, case, whitespace or wildcard matching)", async () => {
    const { session } = await setup([
      " form.read",
      "form.read ",
      "FORM.READ",
      "Form.Read",
      "form.read\u0000",
      "form.readonly",
      "form.reads",
      "form",
      "form.",
      "form.*",
      "*",
      "**",
      ".*",
      "all",
      "admin",
      "OWNER",
    ]);

    for (const permission of ALL_PERMISSIONS) {
      expect((await attempt(permission, session)).status, permission).toBe(
        403,
      );
    }
  });

  it("role NAMES grant nothing by themselves", async () => {
    for (const name of ROLE_NAME_LIST) {
      const { session } = await setup([], name);

      for (const permission of [
        PERMISSIONS.USER_DELETE,
        PERMISSIONS.ORGANIZATION_UPDATE,
        PERMISSIONS.FORM_READ,
      ]) {
        expect(
          (await attempt(permission, session)).status,
          `${name}/${permission}`,
        ).toBe(403);
      }
    }
  });
});

describe("403 responses expose no internals", () => {
  it("never names permissions or roles, and is identical for every cause", async () => {
    // Cause 1: no roles at all.
    const noRoles = await createTestUser();
    const noRolesSession = await createTestSession(noRoles);

    // Cause 2: a role without the permission.
    const wrongRole = await setup([PERMISSIONS.FORM_READ]);

    // Cause 3: only a foreign organization's privileged role.
    const attacker = await createTestUser();
    const otherOrg = await createTestUser();
    const foreignOwner = await createRole(
      otherOrg.organizationId,
      ROLE_NAMES.OWNER,
      OWNER_PERMISSIONS,
    );
    await assignRoles(attacker, [foreignOwner._id]);
    const attackerSession = await createTestSession(attacker);

    const target = PERMISSIONS.USER_DELETE;

    const responses = [
      await attempt(target, noRolesSession),
      await attempt(target, wrongRole.session),
      await attempt(target, attackerSession),
    ];

    for (const res of responses) {
      expect(res.status).toBe(403);
      expectStandardError(res.body as ErrorBody, "FORBIDDEN");
      expect((res.body as ErrorBody).error.fields).toEqual({});
      expectNoInternals(res.body);

      const raw = JSON.stringify(res.body);

      for (const permission of ALL_PERMISSIONS) {
        expect(raw).not.toContain(permission);
      }

      for (const name of ROLE_NAME_LIST) {
        expect(raw).not.toContain(name);
      }

      expect(raw).not.toContain(foreignOwner._id.toString());
      expect(raw).not.toContain(otherOrg.organizationId);
    }

    expect(responses[1]?.body).toEqual(responses[0]?.body);
    expect(responses[2]?.body).toEqual(responses[0]?.body);
  });
});

describe("privilege escalation attempts", () => {
  it("forged organizationId in body, query and headers cannot select another tenant or its roles", async () => {
    const attacker = await setup([PERMISSIONS.FORM_READ]);

    const victimOrg = await createTestUser();
    const victimOwner = await createRole(
      victimOrg.organizationId,
      ROLE_NAMES.OWNER,
      OWNER_PERMISSIONS,
    );

    const forged = {
      organizationId: victimOrg.organizationId,
      roleIds: [victimOwner._id.toString()],
      userId: victimOrg.userId,
      permissions: [...OWNER_PERMISSIONS],
      role: "OWNER",
    };

    const denied = await request(testApp)
      .post(`/guarded/${PERMISSIONS.USER_DELETE}`)
      .query(forged)
      .set("Authorization", bearer(attacker.session.accessToken))
      .set("X-Organization-Id", victimOrg.organizationId)
      .set("X-Role-Ids", victimOwner._id.toString())
      .set("X-User-Id", victimOrg.userId)
      .send(forged);

    expect(denied.status).toBe(403);

    const context = await request(testApp)
      .get("/active")
      .query(forged)
      .set("Authorization", bearer(attacker.session.accessToken))
      .set("X-Organization-Id", victimOrg.organizationId)
      .set("X-User-Id", victimOrg.userId)
      .send(forged);

    expect(context.status).toBe(200);
    expect(context.body.data.organizationId).toBe(
      attacker.user.organizationId,
    );
    expect(context.body.data.userId).toBe(attacker.user.userId);
  });

  it("a user cannot gain permissions by getting a foreign role id stored on their account", async () => {
    const attacker = await createTestUser();
    const own = await createRole(
      attacker.organizationId,
      ROLE_NAMES.VIEWER,
      [PERMISSIONS.FORM_READ],
    );

    const otherOrg = await createTestUser();
    const foreign = await createRole(
      otherOrg.organizationId,
      ROLE_NAMES.OWNER,
      OWNER_PERMISSIONS,
    );

    await assignRoles(attacker, [own._id, foreign._id]);
    const session = await createTestSession(attacker);

    for (const permission of ALL_PERMISSIONS) {
      const expected = permission === PERMISSIONS.FORM_READ ? 200 : 403;

      expect((await attempt(permission, session)).status, permission).toBe(
        expected,
      );
    }
  });

  it("changing a role's permissions or membership takes effect on the next request", async () => {
    const { user, role, session } = await setup(OWNER_PERMISSIONS, ROLE_NAMES.OWNER);

    expect(
      (await attempt(PERMISSIONS.USER_DELETE, session)).status,
    ).toBe(200);

    // Demote: remove one permission.
    await Role.updateOne(
      { _id: role._id },
      {
        $set: {
          permissions: OWNER_PERMISSIONS.filter(
            (permission) => permission !== PERMISSIONS.USER_DELETE,
          ),
        },
      },
    );

    expect(
      (await attempt(PERMISSIONS.USER_DELETE, session)).status,
    ).toBe(403);
    expect(
      (await attempt(PERMISSIONS.USER_READ, session)).status,
    ).toBe(200);

    // Remove the user from the role.
    await assignRoles(user, []);

    expect((await attempt(PERMISSIONS.USER_READ, session)).status).toBe(
      403,
    );

    // Re-add, then delete the role document itself.
    await assignRoles(user, [role._id]);
    expect((await attempt(PERMISSIONS.USER_READ, session)).status).toBe(
      200,
    );

    await Role.deleteOne({ _id: role._id });

    expect((await attempt(PERMISSIONS.USER_READ, session)).status).toBe(
      403,
    );
  });

  it("an OWNER of organization A has no power in organization B", async () => {
    const ownerA = await setup(OWNER_PERMISSIONS, ROLE_NAMES.OWNER);
    const ownerB = await setup(OWNER_PERMISSIONS, ROLE_NAMES.OWNER);

    // Each passes in their own tenant...
    expect((await attempt(PERMISSIONS.USER_DELETE, ownerA.session)).status).toBe(200);
    expect((await attempt(PERMISSIONS.USER_DELETE, ownerB.session)).status).toBe(200);

    // ...and a token pairing A's user with B's organization is refused.
    const forged = await createTestSession({
      userId: ownerA.user.userId,
      organizationId: ownerB.user.organizationId,
      email: ownerA.user.email,
    });

    expect((await attempt(PERMISSIONS.USER_DELETE, forged)).status).toBe(401);
  });
});

describe("tenant filter on role resolution", () => {
  it("returns only roles that belong to the requested organization", async () => {
    const a = await createTestUser();
    const b = await createTestUser();

    const roleA = await createRole(a.organizationId, ROLE_NAMES.VIEWER, [
      PERMISSIONS.FORM_READ,
    ]);
    const roleB = await createRole(b.organizationId, ROLE_NAMES.OWNER, [
      PERMISSIONS.USER_DELETE,
    ]);

    const orgA = new mongoose.Types.ObjectId(a.organizationId);
    const orgB = new mongoose.Types.ObjectId(b.organizationId);

    const forA = await findRolesByIdsForOrganization(
      [roleA._id, roleB._id],
      orgA,
    );
    const forB = await findRolesByIdsForOrganization(
      [roleA._id, roleB._id],
      orgB,
    );

    expect(forA.map((role) => role._id.toString())).toEqual([
      roleA._id.toString(),
    ]);
    expect(forB.map((role) => role._id.toString())).toEqual([
      roleB._id.toString(),
    ]);
  });

  it("returns nothing for no ids, an unknown organization, or only foreign ids", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const roleB = await createRole(b.organizationId, ROLE_NAMES.OWNER, [
      PERMISSIONS.USER_DELETE,
    ]);

    expect(
      await findRolesByIdsForOrganization(
        [],
        new mongoose.Types.ObjectId(a.organizationId),
      ),
    ).toEqual([]);

    expect(
      await findRolesByIdsForOrganization(
        [roleB._id],
        new mongoose.Types.ObjectId(a.organizationId),
      ),
    ).toEqual([]);

    expect(
      await findRolesByIdsForOrganization(
        [roleB._id],
        new mongoose.Types.ObjectId(),
      ),
    ).toEqual([]);
  });
});
