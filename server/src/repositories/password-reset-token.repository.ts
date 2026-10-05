import { createHash } from "node:crypto";
import { redisClient } from "../config/redis.js";

const PASSWORD_RESET_TOKEN_PREFIX = "auth:password-reset";
const PASSWORD_RESET_USER_PREFIX = "auth:password-reset-user";
const PASSWORD_RESET_COOLDOWN_PREFIX =
  "auth:password-reset-cooldown";

export interface PasswordResetTokenPayload {
  userId: string;
  organizationId: string;
}

const sha256 = (value: string): string => {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
};

const getTokenKey = (tokenHash: string): string => {
  return `${PASSWORD_RESET_TOKEN_PREFIX}:${tokenHash}`;
};

/*
 * Points at the user's single active reset token, so a newer request
 * invalidates the previously emailed link.
 */
const getUserPointerKey = (userId: string): string => {
  return `${PASSWORD_RESET_USER_PREFIX}:${sha256(userId)}`;
};

const parsePayload = (
  value: string | null,
): PasswordResetTokenPayload | null => {
  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "userId" in parsed &&
      "organizationId" in parsed &&
      typeof parsed.userId === "string" &&
      typeof parsed.organizationId === "string"
    ) {
      return {
        userId: parsed.userId,
        organizationId: parsed.organizationId,
      };
    }
  } catch {
    // Fall through: treat unreadable values as an invalid token.
  }

  return null;
};

export const savePasswordResetToken = async (
  tokenHash: string,
  payload: PasswordResetTokenPayload,
  ttlSeconds: number,
): Promise<void> => {
  const pointerKey = getUserPointerKey(payload.userId);

  const previousTokenHash = await redisClient.get(pointerKey);

  if (previousTokenHash) {
    await redisClient.del(getTokenKey(previousTokenHash));
  }

  await redisClient
    .multi()
    .set(getTokenKey(tokenHash), JSON.stringify(payload), {
      EX: ttlSeconds,
    })
    .set(pointerKey, tokenHash, { EX: ttlSeconds })
    .exec();
};

/*
 * Reads a token without consuming it.
 */
export const peekPasswordResetToken = async (
  tokenHash: string,
): Promise<PasswordResetTokenPayload | null> => {
  return parsePayload(
    await redisClient.get(getTokenKey(tokenHash)),
  );
};

/*
 * Atomically reads and deletes a token. Only one caller can win.
 */
export const consumePasswordResetToken = async (
  tokenHash: string,
): Promise<PasswordResetTokenPayload | null> => {
  const payload = parsePayload(
    await redisClient.getDel(getTokenKey(tokenHash)),
  );

  if (payload) {
    await clearUserPointer(payload.userId, tokenHash);
  }

  return payload;
};

export const deletePasswordResetToken = async (
  tokenHash: string,
  userId: string,
): Promise<void> => {
  await redisClient.del(getTokenKey(tokenHash));
  await clearUserPointer(userId, tokenHash);
};

const clearUserPointer = async (
  userId: string,
  tokenHash: string,
): Promise<void> => {
  const pointerKey = getUserPointerKey(userId);

  // The pointer expires on its own; only remove it if it still refers
  // to this token and never fail the caller over cleanup.
  try {
    if ((await redisClient.get(pointerKey)) === tokenHash) {
      await redisClient.del(pointerKey);
    }
  } catch {
    // ignored: TTL cleans the pointer up
  }
};

export const createPasswordResetCooldownKey = (
  email: string,
): string => {
  return `${PASSWORD_RESET_COOLDOWN_PREFIX}:${sha256(email)}`;
};

export const acquirePasswordResetCooldown = async (
  cooldownKey: string,
  ttlSeconds: number,
): Promise<boolean> => {
  const result = await redisClient.set(cooldownKey, "1", {
    NX: true,
    EX: ttlSeconds,
  });

  return result === "OK";
};
