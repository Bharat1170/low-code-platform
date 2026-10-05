import jwt, { type SignOptions } from "jsonwebtoken";

import { env } from "../config/env.js";

export interface AccessTokenPayload {
  sub: string;
  organizationId: string;
  sessionId: string;
  type: "access";
}

export const generateAccessToken = (
  payload: Omit<AccessTokenPayload, "type">,
): string => {
  return jwt.sign(
    {
      organizationId: payload.organizationId,
      sessionId: payload.sessionId,
      type: "access",
    },
    env.JWT_ACCESS_SECRET,
    {
      subject: payload.sub,
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"],
      algorithm: "HS256",
    },
  );
};

/*
 * Every identity claim is a MongoDB ObjectId. A validly signed token with
 * anything else is malformed and must be rejected here (401), not fail
 * later with a 500 when the value is cast to an ObjectId.
 */
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export const verifyAccessToken = (
  token: string,
): AccessTokenPayload => {
  const decoded = jwt.verify(
    token,
    env.JWT_ACCESS_SECRET,
    {
      algorithms: ["HS256"],
    },
  );

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof decoded.sub !== "string" ||
    typeof decoded.organizationId !== "string" ||
    typeof decoded.sessionId !== "string" ||
    !OBJECT_ID_PATTERN.test(decoded.sub) ||
    !OBJECT_ID_PATTERN.test(decoded.organizationId) ||
    !OBJECT_ID_PATTERN.test(decoded.sessionId) ||
    decoded.type !== "access"
  ) {
    throw new Error("Invalid access token");
  }

  return {
    sub: decoded.sub,
    organizationId: decoded.organizationId,
    sessionId: decoded.sessionId,
    type: "access",
  };
};