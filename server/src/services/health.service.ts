import mongoose from "mongoose";

import { redisClient } from "../config/redis.js";

/*
 * Readiness checks.
 *
 * Both checks reuse the application's existing connections (no second
 * connection system) and are cheap: an in-memory state check first, then
 * a single PING bounded by a timeout, so a hung dependency can never
 * hang the probe.
 *
 * Failure details are never returned to callers. They are logged
 * server-side by dependency name and error class only, never the error
 * message (which can contain hosts, URLs or credentials).
 */
const CHECK_TIMEOUT_MS = 2000;

let shuttingDown = false;

/*
 * Called when graceful shutdown starts, so load balancers stop sending
 * traffic before the connections are closed.
 */
export const markShuttingDown = (): void => {
  shuttingDown = true;
};

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Dependency check timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);

    // If the timeout won, the operation may still reject later.
    operation.catch(() => undefined);
  }
};

const checkMongo = async (): Promise<boolean> => {
  if (
    mongoose.connection.readyState !==
    mongoose.ConnectionStates.connected
  ) {
    return false;
  }

  const db = mongoose.connection.db;

  if (!db) {
    return false;
  }

  await withTimeout(db.admin().ping(), CHECK_TIMEOUT_MS);

  return true;
};

const checkRedis = async (): Promise<boolean> => {
  // isReady is false while connecting, reconnecting or closed. Checking
  // it first also avoids queueing a PING that could never be answered.
  if (!redisClient.isReady) {
    return false;
  }

  await withTimeout(redisClient.ping(), CHECK_TIMEOUT_MS);

  return true;
};

const runCheck = async (
  name: "mongodb" | "redis",
  check: () => Promise<boolean>,
): Promise<boolean> => {
  try {
    const healthy = await check();

    if (!healthy) {
      console.error(`❌ Readiness: ${name} is not available`);
    }

    return healthy;
  } catch (error) {
    // Unexpected failure: not ready. Class name only, never the message.
    console.error(
      `❌ Readiness: ${name} check failed (${
        error instanceof Error ? error.name : "unknown error"
      })`,
    );

    return false;
  }
};

/*
 * True only when the process is not shutting down AND every required
 * dependency answered. Any failure, timeout or unexpected error means
 * not ready; this function never throws.
 */
export const isReady = async (): Promise<boolean> => {
  if (shuttingDown) {
    return false;
  }

  const [mongoReady, redisReady] = await Promise.all([
    runCheck("mongodb", checkMongo),
    runCheck("redis", checkRedis),
  ]);

  return mongoReady && redisReady;
};
