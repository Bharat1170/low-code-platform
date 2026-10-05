import type { Request } from "express";

import { REFRESH_TOKEN_COOKIE_NAME } from "./auth-cookie.util.js";

export const getRefreshTokenFromRequest = (
  req: Request,
): string | null => {
  const refreshToken =
    req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];

  if (
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    return null;
  }

  return refreshToken;
};