/*
 * Shapes of the existing backend auth API (server/src/controllers/auth.controller.ts).
 * Only fields the server actually returns are modelled here.
 */

export interface AuthUser {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  organizationId: string;
}

export interface AuthOrganization {
  id: string;
  name: string;
}

/* POST /auth/register body. Organization and roles are created server-side. */
export interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  organizationName: string;
}

/* POST /auth/register response `data`. No session is created. */
export interface RegisterResult {
  userId: string;
  organizationId: string;
  email: string;
}

/* POST /auth/login body. */
export interface LoginRequest {
  email: string;
  password: string;
}

/* GET /auth/me response `data` (added in 8.17.13A). */
export interface CurrentUser {
  user: AuthUser;
  organization: AuthOrganization;
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export type FieldErrors<T extends string> = Partial<Record<T, string>>;
