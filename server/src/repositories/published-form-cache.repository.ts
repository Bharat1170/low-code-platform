import type mongoose from "mongoose";

import { redisClient } from "../config/redis.js";

/*
 * Published-form cache boundary (8.17.13).
 *
 * Nothing reads or writes published forms through the cache yet (the
 * published renderer is a later step). This module defines the key and the
 * invalidation that publishing calls, so the future reader and the
 * publisher agree on one key. Keys are per organization AND form; only
 * that exact key is deleted. Redis is never flushed.
 */

export const publishedFormCacheKey = (
  organizationId: mongoose.Types.ObjectId | string,
  formId: mongoose.Types.ObjectId | string,
): string => {
  return `published-form:${organizationId.toString()}:${formId.toString()}`;
};

export const invalidatePublishedFormCache = async (
  organizationId: mongoose.Types.ObjectId | string,
  formId: mongoose.Types.ObjectId | string,
): Promise<void> => {
  await redisClient.del(publishedFormCacheKey(organizationId, formId));
};

/*
 * Read-through cache entries are a copy of the published representation,
 * never the source of truth. They expire on their own as well as being
 * invalidated by publish / form changes.
 */
export const PUBLISHED_FORM_CACHE_TTL_SECONDS = 300;

export const readPublishedFormCache = async (
  organizationId: mongoose.Types.ObjectId | string,
  formId: mongoose.Types.ObjectId | string,
): Promise<unknown | null> => {
  const raw = await redisClient.get(
    publishedFormCacheKey(organizationId, formId),
  );

  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

export const writePublishedFormCache = async (
  organizationId: mongoose.Types.ObjectId | string,
  formId: mongoose.Types.ObjectId | string,
  value: unknown,
): Promise<void> => {
  await redisClient.set(
    publishedFormCacheKey(organizationId, formId),
    JSON.stringify(value),
    { EX: PUBLISHED_FORM_CACHE_TTL_SECONDS },
  );
};
