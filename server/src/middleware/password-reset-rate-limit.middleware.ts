import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { AUTH_CONSTANTS } from "../constants/auth.constants.js";
import { AppError } from "../utils/errors.js";
import { hashToken } from "../utils/token.util.js";
import { incrementRateLimitCounter } from "./login-rate-limit.middleware.js";

const FORGOT_PASSWORD_PREFIX = "auth:forgot-password-rate";
const RESET_PASSWORD_PREFIX = "auth:reset-password-rate";
const CHANGE_PASSWORD_PREFIX = "auth:change-password-rate";

const createKey = (
  prefix: string,
  scope: "ip" | "email" | "user",
  value: string,
): string => {
  return `${prefix}:${scope}:${hashToken(value)}`;
};

const applyLimit = async (
  res: Response,
  key: string,
  maxAttempts: number,
): Promise<void> => {
  const result = await incrementRateLimitCounter(
    key,
    maxAttempts,
  );

  if (!result.allowed) {
    res.setHeader("Retry-After", result.retryAfterSeconds);

    throw new AppError(
      429,
      "RATE_LIMIT_EXCEEDED",
      "Too many requests. Please try again later.",
    );
  }
};

/*
 * Counts every forgot-password request, whether or not the account
 * exists, so the limits reveal nothing about accounts.
 *
 * If Redis is unavailable the limiter fails open: the service itself
 * needs Redis to issue a token, so no email can be sent while it is
 * down, and the response stays the generic 200.
 */
export const forgotPasswordRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await applyLimit(
      res,
      createKey(
        FORGOT_PASSWORD_PREFIX,
        "ip",
        req.ip ?? "unknown",
      ),
      AUTH_CONSTANTS.FORGOT_PASSWORD_MAX_ATTEMPTS_PER_IP,
    );

    const rawEmail =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    if (rawEmail) {
      await applyLimit(
        res,
        createKey(FORGOT_PASSWORD_PREFIX, "email", rawEmail),
        AUTH_CONSTANTS.FORGOT_PASSWORD_MAX_ATTEMPTS_PER_EMAIL,
      );
    }

    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }

    console.error(
      "❌ Forgot-password rate limiter unavailable:",
      error instanceof Error ? error.name : "unknown error",
    );

    next();
  }
};

export const resetPasswordRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    await applyLimit(
      res,
      createKey(
        RESET_PASSWORD_PREFIX,
        "ip",
        req.ip ?? "unknown",
      ),
      AUTH_CONSTANTS.RESET_PASSWORD_MAX_ATTEMPTS_PER_IP,
    );

    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }

    console.error(
      "❌ Reset-password rate limiter unavailable:",
      error instanceof Error ? error.name : "unknown error",
    );

    next(
      new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      ),
    );
  }
};

/*
 * Change password is an authenticated route, so the limit is keyed by
 * the userId from the verified JWT (never from the request) plus the
 * client IP. Run it AFTER authenticate. Fails closed: this endpoint
 * verifies a password, so it must not run unthrottled.
 */
export const changePasswordRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = req.auth?.userId;

    if (!userId) {
      next(
        new AppError(401, "UNAUTHORIZED", "Authentication required"),
      );
      return;
    }

    await applyLimit(
      res,
      createKey(CHANGE_PASSWORD_PREFIX, "user", userId),
      AUTH_CONSTANTS.CHANGE_PASSWORD_MAX_ATTEMPTS_PER_USER,
    );

    await applyLimit(
      res,
      createKey(
        CHANGE_PASSWORD_PREFIX,
        "ip",
        req.ip ?? "unknown",
      ),
      AUTH_CONSTANTS.CHANGE_PASSWORD_MAX_ATTEMPTS_PER_IP,
    );

    next();
  } catch (error) {
    if (error instanceof AppError) {
      next(error);
      return;
    }

    console.error(
      "❌ Change-password rate limiter unavailable:",
      error instanceof Error ? error.name : "unknown error",
    );

    next(
      new AppError(
        503,
        "SERVICE_UNAVAILABLE",
        "Service temporarily unavailable",
      ),
    );
  }
};
