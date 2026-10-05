import { createClient } from "redis";

import { env } from "./env.js";

export const redisClient = createClient({
  url: env.REDIS_URL,
});

redisClient.on("error", (error) => {
  console.error("❌ Redis client error:", error);
});

export const connectRedis = async (): Promise<void> => {
  try {
    if (redisClient.isOpen) {
      return;
    }

    await redisClient.connect();

    await redisClient.ping();

    console.log("✅ Redis connected successfully");
  } catch (error) {
    console.error("❌ Redis connection failed");

    throw error;
  }
};

export const disconnectRedis = async (): Promise<void> => {
  if (!redisClient.isOpen) {
    return;
  }

  await redisClient.quit();

  console.log("Redis disconnected");
};