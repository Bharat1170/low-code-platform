import { createHash, randomBytes } from "node:crypto";

import { AUTH_CONSTANTS } from "../constants/auth.constants.js";

export const generateSecureToken = (
  bytes: number,
): string => {
  return randomBytes(bytes).toString("hex");
};

export const hashToken = (
  token: string,
): string => {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
};

export const generateRefreshToken = (): string => {
  return generateSecureToken(
    AUTH_CONSTANTS.REFRESH_TOKEN_BYTES,
  );
};