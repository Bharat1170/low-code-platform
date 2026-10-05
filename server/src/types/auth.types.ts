import type { Permission } from "../constants/permissions.js";

/*
 * Identity extracted from a verified access token.
 * This is the only trusted source of userId, organizationId
 * and sessionId for authenticated requests.
 */
export interface AuthContext {
  userId: string;
  organizationId: string;
  sessionId: string;
}

/*
 * Server-side account state, loaded from the database for the
 * authenticated user (never taken from the request).
 */
export interface ActiveAccountContext {
  userId: string;
  organizationId: string;
  roleIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      account?: ActiveAccountContext;
      permissions?: ReadonlySet<Permission>;
    }
  }
}
