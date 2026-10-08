/*
 * Public sharing URL of a published form. It is built ONLY from the
 * server-issued publicId, never from the internal form id, and only for an
 * identifier of exactly the shape the server generates, so nothing else can
 * end up in a link that is handed to other people.
 */

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export const isValidPublicId = (value: unknown): value is string =>
  typeof value === "string" && PUBLIC_ID_PATTERN.test(value);

export const publicFormPath = (publicId: string): string => {
  if (!isValidPublicId(publicId)) {
    throw new Error("Invalid public id");
  }

  return `/f/${publicId}`;
};

/* The origin is the one the app is served from, so it is right in every environment. */
export const publicFormUrl = (
  publicId: string,
  origin: string = window.location.origin,
): string => `${origin}${publicFormPath(publicId)}`;
