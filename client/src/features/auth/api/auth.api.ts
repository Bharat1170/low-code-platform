import {
  ApiError,
  authorizedRequest,
  clearAccessToken,
  publicRequest,
  refreshAccessToken,
  setAccessToken,
} from "../../../lib/http.ts";
import type {
  AuthOrganization,
  AuthUser,
  CurrentUser,
  LoginRequest,
  RegisterRequest,
  RegisterResult,
} from "../types/auth.types.ts";

/*
 * Client for the existing /api/auth endpoints. Passwords only ever travel
 * in a JSON request body: never in a URL, storage or logs.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const invalid = (): ApiError =>
  new ApiError(500, "INVALID_RESPONSE", "Unexpected server response");

const dataOf = (body: unknown): Record<string, unknown> => {
  if (isRecord(body) && isRecord(body.data)) return body.data;
  throw invalid();
};

const str = (value: unknown): string => {
  if (typeof value === "string") return value;
  throw invalid();
};

const toUser = (value: unknown): AuthUser => {
  if (!isRecord(value)) throw invalid();

  return {
    id: str(value.id),
    firstName: str(value.firstName),
    lastName: str(value.lastName),
    email: str(value.email),
    organizationId: str(value.organizationId),
  };
};

const toOrganization = (value: unknown): AuthOrganization => {
  if (!isRecord(value)) throw invalid();

  return { id: str(value.id), name: str(value.name) };
};

export const register = async (
  request: RegisterRequest,
): Promise<RegisterResult> => {
  const body = await publicRequest("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      firstName: request.firstName.trim(),
      lastName: request.lastName.trim(),
      email: request.email.trim(),
      password: request.password,
      organizationName: request.organizationName.trim(),
    }),
  });
  const data = dataOf(body);

  return {
    userId: str(data.userId),
    organizationId: str(data.organizationId),
    email: str(data.email),
  };
};

/* Signs in and keeps the access token in memory. Returns the user. */
export const login = async (request: LoginRequest): Promise<AuthUser> => {
  const body = await publicRequest("/auth/login", {
    method: "POST",
    body: JSON.stringify({
      email: request.email.trim(),
      password: request.password,
    }),
  });
  const data = dataOf(body);

  const user = toUser(data.user);
  setAccessToken(str(data.accessToken));

  return user;
};

/* Uses the httpOnly refresh cookie to obtain a new access token. */
export const refresh = async (): Promise<void> => {
  await refreshAccessToken();
};

export const getCurrentUser = async (): Promise<CurrentUser> => {
  const data = dataOf(await authorizedRequest("/auth/me"));

  return {
    user: toUser(data.user),
    organization: toOrganization(data.organization),
  };
};

/*
 * Asks the server to revoke the session and clear the refresh cookie (JS
 * cannot touch an httpOnly cookie). The local token is dropped whether or
 * not the server could be reached.
 */
export const logout = async (): Promise<void> => {
  try {
    await publicRequest("/auth/logout", { method: "POST" });
  } finally {
    clearAccessToken();
  }
};
