import { redisClient } from "../config/redis.js";
import { hashToken } from "../utils/token.util.js";

const LOGIN_FAILURE_PREFIX = "auth:login-failure";

const createFailureKey = (
  email: string,
  ipAddress: string,
): string => {
  const normalizedValue =
    `${email.trim().toLowerCase()}:${ipAddress}`;

  return `${LOGIN_FAILURE_PREFIX}:${hashToken(normalizedValue)}`;
};

export const recordFailedLoginAttempt = async (
  email: string,
  ipAddress: string,
  ttlSeconds: number,
): Promise<number> => {
  if (!redisClient.isReady) {
    throw new Error("Redis is not ready");
  }

  const key = createFailureKey(email, ipAddress);

  const attemptCount = await redisClient.incr(key);

  if (attemptCount === 1) {
    await redisClient.expire(key, ttlSeconds);
  }

  return attemptCount;
};

export const clearFailedLoginAttempts = async (
  email: string,
  ipAddress: string,
): Promise<void> => {
  if (!redisClient.isReady) {
    throw new Error("Redis is not ready");
  }

  const key = createFailureKey(email, ipAddress);

  await redisClient.del(key);
};