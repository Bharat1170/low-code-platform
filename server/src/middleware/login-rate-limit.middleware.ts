import { Request, Response, NextFunction } from "express";

import { redisClient } from "../config/redis.js";
import { AUTH_CONSTANTS } from "../constants/auth.constants.js";
import { hashToken } from "../utils/token.util.js";

const LOGIN_RATE_LIMIT_PREFIX = "auth:login-rate";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export const incrementRateLimitCounter = async (
  key: string,
  maxAttempts: number,
): Promise<RateLimitResult> => {
  if (!redisClient.isReady) {
    throw new Error("Redis is not ready");
  }

  const currentCount = await redisClient.incr(key);

  if (currentCount === 1) {
    await redisClient.expire(
      key,
      AUTH_CONSTANTS.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    );
  }

  if (currentCount <= maxAttempts) {
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }

  const ttl = await redisClient.ttl(key);

  return {
    allowed: false,
    retryAfterSeconds:
      ttl > 0
        ? ttl
        : AUTH_CONSTANTS.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
  };
};

const createRateLimitKey = (
  scope: "ip" | "email",
  value: string,
): string => {
  return `${LOGIN_RATE_LIMIT_PREFIX}:${scope}:${hashToken(value)}`;
};

export const loginRateLimit = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const ipAddress = req.ip ?? "unknown";

    const rawEmail =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";

    const ipKey = createRateLimitKey(
      "ip",
      ipAddress,
    );

    const ipResult = await incrementRateLimitCounter(
      ipKey,
      AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_IP,
    );

    if (!ipResult.allowed) {
      res.setHeader(
        "Retry-After",
        ipResult.retryAfterSeconds,
      );

      res.status(429).json({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message:
            "Too many login attempts. Please try again later.",
          fields: {},
        },
      });

      return;
    }

    if (rawEmail) {
      const emailKey = createRateLimitKey(
        "email",
        rawEmail,
      );

      const emailResult =
        await incrementRateLimitCounter(
          emailKey,
          AUTH_CONSTANTS.LOGIN_RATE_LIMIT_MAX_ATTEMPTS_PER_EMAIL,
        );

      if (!emailResult.allowed) {
        res.setHeader(
          "Retry-After",
          emailResult.retryAfterSeconds,
        );

        res.status(429).json({
          success: false,
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message:
              "Too many login attempts. Please try again later.",
            fields: {},
          },
        });

        return;
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};