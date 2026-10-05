import { type Response } from "express";

import { env } from "../config/env.js";
import { parseDurationToMilliseconds } from "./duration.util.js";

export const REFRESH_TOKEN_COOKIE_NAME = "refreshToken";

const getRefreshTokenCookieMaxAge = (): number => {
  return parseDurationToMilliseconds(
    env.JWT_REFRESH_EXPIRES_IN,
  );
};

export const setRefreshTokenCookie = (
  res: Response,
  refreshToken: string,
): void => {
  res.cookie(
    REFRESH_TOKEN_COOKIE_NAME,
    refreshToken,
    {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: getRefreshTokenCookieMaxAge(),
      path: "/api/auth",
    },
  );
};

export const clearRefreshTokenCookie = (
  res: Response,
): void => {
  res.clearCookie(
    REFRESH_TOKEN_COOKIE_NAME,
    {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/auth",
    },
  );
};