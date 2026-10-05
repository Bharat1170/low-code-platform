import { createHash } from "node:crypto";
import { redisClient } from "../config/redis.js";

const VERIFICATION_TOKEN_PREFIX = "auth:email-verification";
const VERIFICATION_RESEND_COOLDOWN_PREFIX =
  "auth:email-verification-resend";

const getVerificationTokenKey = (tokenHash: string): string => {
  return `${VERIFICATION_TOKEN_PREFIX}:${tokenHash}`;
};

export const saveVerificationToken = async (
  tokenHash: string,
  userId: string,
  ttlSeconds: number,
): Promise<void> => {
  const key = getVerificationTokenKey(tokenHash);

  await redisClient.set(key, userId, {
    EX: ttlSeconds,
  });
};

export const getVerificationTokenUserId = async (
  tokenHash: string,
): Promise<string | null> => {
  const key = getVerificationTokenKey(tokenHash);

  return redisClient.get(key);
};

export const consumeVerificationToken = async (
  tokenHash: string,
): Promise<string | null> => {
  const key = getVerificationTokenKey(tokenHash);

  return redisClient.getDel(key);
};

export const deleteVerificationToken = async (
  tokenHash: string,
): Promise<void> => {
  const key = getVerificationTokenKey(tokenHash);

  await redisClient.del(key);
};


export const acquireVerificationResendCooldown = async (
  cooldownKey: string,
  ttlSeconds: number,
): Promise<boolean> => {
  const result = await redisClient.set(
    cooldownKey,
    "1",
    {
      NX: true,
      EX: ttlSeconds,
    },
  );

  return result === "OK";
};

export const createVerificationResendCooldownKey = (
  organizationId: string,
  email: string,
): string => {
  const value = `${organizationId}:${email}`;

  const hash = createHash("sha256")
    .update(value, "utf8")
    .digest("hex");

  return `${VERIFICATION_RESEND_COOLDOWN_PREFIX}:${hash}`;
};