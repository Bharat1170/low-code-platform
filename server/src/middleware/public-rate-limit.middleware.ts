import type { NextFunction, Request, RequestHandler, Response } from "express";

import { redisClient } from "../config/redis.js";
import { AppError } from "../utils/errors.js";
import { hashToken } from "../utils/token.util.js";

/*
 * Redis-backed fixed-window limits for the unauthenticated share-link
 * endpoints. Counters are shared by every server instance (unlike an
 * in-memory store, which is per serverless instance). Keys hold only
 * hashes of the client IP and the publicId, never the raw values.
 *
 * Reads fail open when Redis is unavailable (a form must stay readable);
 * submissions fail closed with 503, so an outage never becomes a window
 * for unthrottled anonymous writes.
 */

export const PUBLIC_RATE_LIMITS = {
  WINDOW_SECONDS: 10 * 60,
  READS_PER_IP: 300,
  SUBMISSIONS_PER_IP: 20,
  SUBMISSIONS_PER_IP_AND_FORM: 10,
} as const;

const PREFIX = "public-rate";

const keyFor = (...parts: string[]): string =>
  `${PREFIX}:${parts.map((part) => hashToken(part)).join(":")}`;

/* Increments a window counter; returns the seconds to wait when over. */
const hit = async (key: string, limit: number): Promise<number | null> => {
  const count = await redisClient.incr(key);

  if (count === 1) {
    await redisClient.expire(key, PUBLIC_RATE_LIMITS.WINDOW_SECONDS);
  }

  if (count <= limit) {
    return null;
  }

  const ttl = await redisClient.ttl(key);
  return ttl > 0 ? ttl : PUBLIC_RATE_LIMITS.WINDOW_SECONDS;
};

const tooMany = (res: Response, retryAfter: number): AppError => {
  res.setHeader("Retry-After", retryAfter);
  return new AppError(
    429,
    "RATE_LIMIT_EXCEEDED",
    "Too many requests. Please try again later.",
  );
};

const publicIdOf = (req: Request): string =>
  typeof req.params.publicId === "string" ? req.params.publicId : "";

export const publicFormReadRateLimit: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  let retryAfter: number | null = null;

  try {
    if (!redisClient.isReady) throw new Error("Redis is not ready");
    retryAfter = await hit(
      keyFor("read", req.ip ?? "unknown"),
      PUBLIC_RATE_LIMITS.READS_PER_IP,
    );
  } catch {
    // Fail open for reads.
    retryAfter = null;
  }

  if (retryAfter !== null) {
    throw tooMany(res, retryAfter);
  }

  next();
};

export const publicSubmissionRateLimit: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const ip = req.ip ?? "unknown";
  let retryAfter: number | null;

  try {
    if (!redisClient.isReady) throw new Error("Redis is not ready");

    retryAfter =
      (await hit(keyFor("submit", ip), PUBLIC_RATE_LIMITS.SUBMISSIONS_PER_IP)) ??
      (await hit(
        keyFor("submit-form", ip, publicIdOf(req)),
        PUBLIC_RATE_LIMITS.SUBMISSIONS_PER_IP_AND_FORM,
      ));
  } catch {
    throw new AppError(
      503,
      "SERVICE_UNAVAILABLE",
      "Submissions are temporarily unavailable. Please try again shortly.",
    );
  }

  if (retryAfter !== null) {
    throw tooMany(res, retryAfter);
  }

  next();
};
