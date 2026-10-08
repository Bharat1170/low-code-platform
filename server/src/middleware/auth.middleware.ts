import type {
  NextFunction,
  Request,
  Response,
} from "express";

import type { AuthContext } from "../types/auth.types.js";
import { isSessionActive } from "../repositories/session.repository.js";
import { AppError } from "../utils/errors.js";
import { verifyAccessToken } from "../utils/jwt.util.js";

const unauthorized = (message: string): AppError => {
  return new AppError(401, "UNAUTHORIZED", message);
};

const extractBearerToken = (req: Request): string => {
  const header = req.get("authorization");

  if (!header) {
    throw unauthorized("Authentication required");
  }

  const parts = header.split(" ");

  if (
    parts.length !== 2 ||
    parts[0]?.toLowerCase() !== "bearer" ||
    !parts[1]
  ) {
    throw unauthorized("Authentication required");
  }

  return parts[1];
};

/*
 * Requires a valid access token whose server-side session is still
 * active. Logout, session revocation, refresh rotation and reuse
 * detection therefore take effect at once, not when the token expires.
 */
export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const token = extractBearerToken(req);

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(token);
  } catch {
    // Do not expose JWT verification details to the client.
    throw unauthorized("Invalid or expired access token");
  }

  // Same message as an invalid token: never reveal why it was rejected.
  if (
    !(await isSessionActive(
      payload.sessionId,
      payload.sub,
      payload.organizationId,
    ))
  ) {
    throw unauthorized("Invalid or expired access token");
  }

  req.auth = {
    userId: payload.sub,
    organizationId: payload.organizationId,
    sessionId: payload.sessionId,
  };

  next();
};

/*
 * Returns the verified identity for the current request.
 * Throws if used on a route that is missing the authenticate middleware.
 */
export const getAuthContext = (req: Request): AuthContext => {
  if (!req.auth) {
    throw unauthorized("Authentication required");
  }

  return req.auth;
};
