import type { ClientRateLimitInfo, Options, Store } from "express-rate-limit";

import { redisClient } from "../config/redis.js";

/*
 * express-rate-limit store backed by the shared Redis client, so the
 * global limit is counted across every server instance (the default
 * memory store is per process, i.e. per serverless instance).
 *
 * Fixed window: the first hit sets the expiry. Errors propagate so the
 * limiter's passOnStoreError setting decides what happens if Redis is down.
 */
export class RedisRateLimitStore implements Store {
  readonly prefix: string;
  readonly localKeys = false;
  private windowMs = 60_000;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (!redisClient.isReady) {
      throw new Error("Redis is not ready");
    }

    const redisKey = this.key(key);
    const totalHits = await redisClient.incr(redisKey);

    if (totalHits === 1) {
      await redisClient.pExpire(redisKey, this.windowMs);
    }

    const ttl = await redisClient.pTTL(redisKey);
    const remainingMs = ttl > 0 ? ttl : this.windowMs;

    return { totalHits, resetTime: new Date(Date.now() + remainingMs) };
  }

  async decrement(key: string): Promise<void> {
    if (redisClient.isReady) {
      await redisClient.decr(this.key(key));
    }
  }

  async resetKey(key: string): Promise<void> {
    if (redisClient.isReady) {
      await redisClient.del(this.key(key));
    }
  }
}
