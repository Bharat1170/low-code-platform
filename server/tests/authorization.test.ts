import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  OWNER_PERMISSIONS,
  ROLE_NAMES,
  type RoleName,
} from "../src/constants/roles.js";
import {
  PERMISSIONS,
  type Permission,
} from "../src/constants/permissions.js";
import { authenticate } from "../src/middleware/auth.middleware.js";
import {
  requireActiveAccount,
  requirePermission,
} from "../src/middleware/authorization.middleware.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { Organization } from "../src/models/organization.model.js";
import { Role } from "../src/models/role.model.js";
import { User } from "../src/models/user.model.js";
import { sendSuccess } from "../src/utils/response.js";

import {
  bearer,
  createTestSession,
  createTestUser,
  objectId,
  type TestSession,
  type TestUser,
} from "./helpers.js";

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET as string;

/*
 * No production route uses these guards yet, so they are exercised on
 * a test-only app that mirrors the intended wiring:
 *   authenticate -> requireActiveAccount / requirePermission -> handler
 */
const testApp = express();
testApp.use(express.json());

const whoAmI: express.RequestHandler = (req, res) => {
  sendSuccess(res, 200, "ok", {
    organizationId: req.account?.organizationId,
    userId: req.account?.userId,
  });
};

testApp.get("/active", authenticate, requireActiveAccount, whoAmI);
testApp.get(
  "/forms/read",
  authenticate,
  requirePermission(PERMISSIONS.FORM_READ),
  whoAmI,
);
testApp.post(
  "/forms/create",
  authenticate,
  requirePermission(PERMISSIONS.FORM_CREATE),
  whoAmI,
);
testApp.post(
  "/forms/publish",
  authenticate,
  requirePermission(PERMISSIONS.FORM_CREATE, PERMISSIONS.FORM_PUBLISH),
  whoAmI,
);
testApp.use(errorHandler);

const createRole = async (
  organizationId: string,
  name: RoleName,
  permissions: readonly string[],
) => {
  return Role.create({
    organizationId,
    name,
    description: "",
    permissions: [...permissions],
  });
};

const assignRoles = async (
  user: TestUser,
  roleIds: mongoose.Types.ObjectId[],
): Promise<void> => {
  await User.updateOne(
    { _id: user.userId },
    { $set: { roleIds } },
  );
};

/*
 * A user holding one role of their own organization with the given
 * permissions.
 */
const userWithPermissions = async (
  permissions: readonly string[],
  name: RoleName = ROLE_NAMES.BUILDER,
): Promise<{
  user: TestUser;
  session: TestSession;
  roleId: mongoose.Types.ObjectId;
}> => {
  const user = await createTestUser();
  const role = await createRole(user.organizationId, name, permissions);
  await assignRoles(user, [role._id]);
  const session = await createTestSession(user);

  return { user, session, roleId: role._id };
};

const get = (path: string, session: TestSession) =>
  request(testApp)
    .get(path)
    .set("Authorization", bearer(session.accessToken));

const post = (path: string, session: TestSession) =>
  request(testApp)
    .post(path)
    .set("Authorization", bearer(session.accessToken));

describe("authenticate (JWT) on guarded routes", () => {
  it("rejects a missing token with 401", async () => {
    const res = await request(testApp).get("/active");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed token with 401", async () => {
    const res = await request(testApp)
      .get("/active")
      .set("Authorization", "Bearer not.a.jwt");

    expect(res.status).toBe(401);
  });

  it("rejects an expired token with 401", async () => {
    const user = await createTestUser();

    const expired = jwt.sign(
      {
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "access",
      },
      ACCESS_SECRET,
      { subject: user.userId, algorithm: "HS256", expiresIn: -10 },
    );

    const res = await request(testApp)
      .get("/active")
      .set("Authorization", bearer(expired));

    expect(res.status).toBe(401);
  });

  it("rejects a token signed with a different algorithm (HS512)", async () => {
    const user = await createTestUser();

    const wrongAlgorithm = jwt.sign(
      {
        organizationId: user.organizationId,
        sessionId: objectId(),
        type: "access",
      },
      ACCESS_SECRET,
      { subject: user.userId, algorithm: "HS512" },
    );

    const res = await request(testApp)
      .get("/active")
      .set("Authorization", bearer(wrongAlgorithm));

    expect(res.status).toBe(401);
  });

  it("rejects a tampered token with 401", async () => {
    const { session } = await userWithPermissions([]);

    const res = await request(testApp)
      .get("/active")
      .set("Authorization", `Bearer ${session.accessToken}x`);

    expect(res.status).toBe(401);
  });
});

describe("requireActiveAccount", () => {
  it("allows an active user in an active organization", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    const res = await get("/active", session);

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(user.userId);
    expect(res.body.data.organizationId).toBe(user.organizationId);
  });

  it.each(["SUSPENDED", "DELETED"])(
    "rejects a %s user even with a valid JWT",
    async (status) => {
      const user = await createTestUser();
      const session = await createTestSession(user);

      await User.updateOne({ _id: user.userId }, { $set: { status } });

      const res = await get("/active", session);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
    },
  );

  it.each(["SUSPENDED", "DELETED"])(
    "rejects a %s organization even with a valid JWT",
    async (status) => {
      const user = await createTestUser();
      const session = await createTestSession(user);

      await Organization.updateOne(
        { _id: user.organizationId },
        { $set: { status } },
      );

      const res = await get("/active", session);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
    },
  );

  it("takes effect immediately for a token issued while the account was active", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    expect((await get("/active", session)).status).toBe(200);

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "SUSPENDED" } },
    );

    expect((await get("/active", session)).status).toBe(403);

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "ACTIVE" } },
    );

    expect((await get("/active", session)).status).toBe(200);
  });

  it("does not reveal whether the user or the organization is inactive, or any account data", async () => {
    const suspendedUser = await createTestUser();
    const suspendedUserSession = await createTestSession(suspendedUser);
    await User.updateOne(
      { _id: suspendedUser.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const suspendedOrg = await createTestUser();
    const suspendedOrgSession = await createTestSession(suspendedOrg);
    await Organization.updateOne(
      { _id: suspendedOrg.organizationId },
      { $set: { status: "SUSPENDED" } },
    );

    const a = await get("/active", suspendedUserSession);
    const b = await get("/active", suspendedOrgSession);

    expect(a.body).toEqual(b.body);

    const raw = JSON.stringify(a.body);
    expect(raw).not.toContain(suspendedUser.email);
    expect(raw).not.toContain("SUSPENDED");
    expect(raw).not.toContain(suspendedUser.userId);
  });

  it("rejects a token for a user that no longer exists with 401", async () => {
    const user = await createTestUser();
    const session = await createTestSession(user);

    await User.deleteOne({ _id: user.userId });

    const res = await get("/active", session);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a token whose organization is not the user's organization", async () => {
    const user = await createTestUser();
    const otherOrg = await createTestUser();

    const forged = await createTestSession({
      userId: user.userId,
      organizationId: otherOrg.organizationId,
      email: user.email,
    });

    const res = await get("/active", forged);

    expect(res.status).toBe(401);
  });

  it("ignores a client-supplied organizationId (body, query, header)", async () => {
    const orgA = await createTestUser();
    const orgB = await createTestUser();
    const session = await createTestSession(orgA);

    const res = await request(testApp)
      .get("/active")
      .query({ organizationId: orgB.organizationId })
      .set("Authorization", bearer(session.accessToken))
      .set("X-Organization-Id", orgB.organizationId)
      .send({ organizationId: orgB.organizationId });

    expect(res.status).toBe(200);
    expect(res.body.data.organizationId).toBe(orgA.organizationId);
  });
});

describe("requirePermission", () => {
  it("allows a user whose own-organization role grants the permission", async () => {
    const { session } = await userWithPermissions([
      PERMISSIONS.FORM_READ,
    ]);

    const res = await get("/forms/read", session);

    expect(res.status).toBe(200);
  });

  it("returns 401 without authentication", async () => {
    const res = await request(testApp).post("/forms/create");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 FORBIDDEN for a user without the permission", async () => {
    const { session } = await userWithPermissions([
      PERMISSIONS.FORM_READ,
    ]);

    const res = await post("/forms/create", session);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("FORBIDDEN");
    // Does not reveal which permission is missing.
    expect(JSON.stringify(res.body)).not.toContain("form.create");
  });

  it("grants nothing to a user with no roles, or a role with no stored permissions", async () => {
    const noRoles = await createTestUser();
    const noRolesSession = await createTestSession(noRoles);

    const emptyRole = await userWithPermissions([], ROLE_NAMES.VIEWER);

    expect((await get("/forms/read", noRolesSession)).status).toBe(403);
    expect((await get("/forms/read", emptyRole.session)).status).toBe(403);
  });

  it("ignores unknown permission strings and wildcards", async () => {
    const { session } = await userWithPermissions([
      "*",
      "form.*",
      "form.reed",
      "FORM.READ",
      "admin",
    ]);

    expect((await get("/forms/read", session)).status).toBe(403);
  });

  it("combines permissions from several roles of the organization", async () => {
    const user = await createTestUser();
    const reader = await createRole(
      user.organizationId,
      ROLE_NAMES.VIEWER,
      [PERMISSIONS.FORM_READ],
    );
    const creator = await createRole(
      user.organizationId,
      ROLE_NAMES.BUILDER,
      [PERMISSIONS.FORM_CREATE],
    );
    await assignRoles(user, [reader._id, creator._id]);
    const session = await createTestSession(user);

    expect((await get("/forms/read", session)).status).toBe(200);
    expect((await post("/forms/create", session)).status).toBe(200);
    expect((await post("/forms/publish", session)).status).toBe(403);
  });

  it("requires ALL permissions when several are listed", async () => {
    const both = await userWithPermissions([
      PERMISSIONS.FORM_CREATE,
      PERMISSIONS.FORM_PUBLISH,
    ]);
    const onlyOne = await userWithPermissions([
      PERMISSIONS.FORM_CREATE,
    ]);

    expect((await post("/forms/publish", both.session)).status).toBe(200);
    expect(
      (await post("/forms/publish", onlyOne.session)).status,
    ).toBe(403);
  });

  it("refuses to build a guard with no permissions", () => {
    expect(() => requirePermission()).toThrow();
  });

  it("lets the OWNER role (OWNER_PERMISSIONS) through", async () => {
    const { session } = await userWithPermissions(
      OWNER_PERMISSIONS,
      ROLE_NAMES.OWNER,
    );

    expect((await post("/forms/publish", session)).status).toBe(200);
  });

  it("applies permission changes immediately (no stale permissions in the JWT)", async () => {
    const { session, roleId } = await userWithPermissions([
      PERMISSIONS.FORM_READ,
    ]);

    expect((await get("/forms/read", session)).status).toBe(200);

    await Role.updateOne({ _id: roleId }, { $set: { permissions: [] } });

    expect((await get("/forms/read", session)).status).toBe(403);
  });

  it("applies role removal immediately", async () => {
    const { user, session } = await userWithPermissions([
      PERMISSIONS.FORM_READ,
    ]);

    await assignRoles(user, []);

    expect((await get("/forms/read", session)).status).toBe(403);
  });

  it("checks account status before permissions", async () => {
    const { user, session } = await userWithPermissions([
      PERMISSIONS.FORM_READ,
    ]);

    await User.updateOne(
      { _id: user.userId },
      { $set: { status: "SUSPENDED" } },
    );

    const res = await get("/forms/read", session);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_NOT_ACTIVE");
  });
});

describe("RBAC tenant isolation and privilege escalation", () => {
  it("ignores a role from another organization referenced by the user", async () => {
    const attacker = await createTestUser();
    const otherOrg = await createTestUser();

    const foreignRole = await createRole(
      otherOrg.organizationId,
      ROLE_NAMES.OWNER,
      OWNER_PERMISSIONS,
    );

    await assignRoles(attacker, [foreignRole._id]);
    const session = await createTestSession(attacker);

    expect((await post("/forms/create", session)).status).toBe(403);
    expect((await get("/forms/read", session)).status).toBe(403);
  });

  it("takes permissions only from own-organization roles when a foreign role is mixed in", async () => {
    const attacker = await createTestUser();
    const otherOrg = await createTestUser();

    const ownRole = await createRole(
      attacker.organizationId,
      ROLE_NAMES.VIEWER,
      [PERMISSIONS.FORM_READ],
    );
    const foreignRole = await createRole(
      otherOrg.organizationId,
      ROLE_NAMES.BUILDER,
      [PERMISSIONS.FORM_CREATE],
    );

    await assignRoles(attacker, [ownRole._id, foreignRole._id]);
    const session = await createTestSession(attacker);

    expect((await get("/forms/read", session)).status).toBe(200);
    expect((await post("/forms/create", session)).status).toBe(403);
  });

  it("rejects a token that claims another organization even if that organization's role has the permission", async () => {
    const attacker = await createTestUser();
    const victimOrg = await createTestUser();

    await createRole(victimOrg.organizationId, ROLE_NAMES.OWNER, OWNER_PERMISSIONS);

    const forged = await createTestSession({
      userId: attacker.userId,
      organizationId: victimOrg.organizationId,
      email: attacker.email,
    });

    const res = await post("/forms/create", forged);

    expect(res.status).toBe(401);
  });

  it("organization B cannot use organization A's permissions and vice versa", async () => {
    const a = await userWithPermissions([PERMISSIONS.FORM_CREATE]);
    const b = await userWithPermissions([PERMISSIONS.FORM_READ]);

    expect((await post("/forms/create", a.session)).status).toBe(200);
    expect((await post("/forms/create", b.session)).status).toBe(403);
    expect((await get("/forms/read", b.session)).status).toBe(200);
    expect((await get("/forms/read", a.session)).status).toBe(403);
  });

  it("ignores forged role and permission values sent by the frontend", async () => {
    const owner = await userWithPermissions(
      OWNER_PERMISSIONS,
      ROLE_NAMES.OWNER,
    );
    const viewer = await userWithPermissions([PERMISSIONS.FORM_READ]);

    const res = await request(testApp)
      .post("/forms/create")
      .query({
        role: "OWNER",
        roles: "OWNER",
        permissions: PERMISSIONS.FORM_CREATE,
      })
      .set("Authorization", bearer(viewer.session.accessToken))
      .set("X-Role", "OWNER")
      .set("X-Permissions", OWNER_PERMISSIONS.join(","))
      .send({
        role: "OWNER",
        roles: ["OWNER"],
        roleIds: [owner.roleId.toString()],
        permissions: [...OWNER_PERMISSIONS],
        organizationId: owner.user.organizationId,
        userId: owner.user.userId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("does not let a user escalate by referencing a privileged role id from their own organization in the request", async () => {
    const ownerUser = await createTestUser();
    const ownerRole = await createRole(
      ownerUser.organizationId,
      ROLE_NAMES.OWNER,
      OWNER_PERMISSIONS,
    );
    await assignRoles(ownerUser, [ownerRole._id]);

    const limited = await createTestUser({
      organizationId: ownerUser.organizationId,
    });
    const viewerRole = await createRole(
      limited.organizationId,
      ROLE_NAMES.VIEWER,
      [PERMISSIONS.FORM_READ],
    );
    await assignRoles(limited, [viewerRole._id]);
    const limitedSession = await createTestSession(limited);

    const res = await request(testApp)
      .post("/forms/publish")
      .set("Authorization", bearer(limitedSession.accessToken))
      .send({ roleIds: [ownerRole._id.toString()] });

    expect(res.status).toBe(403);

    // Stored roles are untouched.
    const stored = await User.findById(limited.userId).exec();
    expect(stored?.roleIds.map(String)).toEqual([
      viewerRole._id.toString(),
    ]);
  });

  it("never exposes the resolved permission set in responses", async () => {
    const { session } = await userWithPermissions(
      OWNER_PERMISSIONS as readonly Permission[],
      ROLE_NAMES.OWNER,
    );

    const res = await post("/forms/create", session);
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain("permission");
    expect(raw).not.toContain("roleIds");
  });
});
