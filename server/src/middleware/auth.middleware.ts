import type {
  NextFunction,
  Request,
  Response,
} from "express";

import type { AuthContext } from "../types/auth.types.js";
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
 * Requires a valid access token.
 *
 * Note: this verifies the JWT signature and expiry only. It does not
 * look up the server-side session, so an access token issued for a
 * session that was later revoked stays valid until it expires.
 */
export const authenticate = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const token = extractBearerToken(req);

  try {
    const payload = verifyAccessToken(token);

    req.auth = {
      userId: payload.sub,
      organizationId: payload.organizationId,
      sessionId: payload.sessionId,
    };
  } catch {
    // Do not expose JWT verification details to the client.
    throw unauthorized("Invalid or expired access token");
  }

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
