import { randomBytes } from "node:crypto";

/*
 * Public form identifier (the share-link id). 18 random bytes from the
 * OS CSPRNG = 144 bits of entropy, encoded as 24 URL-safe characters.
 * It is unrelated to any ObjectId, slug, organization or user, so it
 * reveals nothing and cannot be guessed or enumerated.
 */
export const PUBLIC_ID_LENGTH = 24;

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export const generatePublicId = (): string => {
  return randomBytes(18).toString("base64url");
};

/* Shape check for untrusted input, before it is used in a query. */
export const isValidPublicId = (value: unknown): value is string => {
  return typeof value === "string" && PUBLIC_ID_PATTERN.test(value);
};
