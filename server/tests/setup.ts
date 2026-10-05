import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach } from "vitest";

import { env } from "../src/config/env.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "../src/config/database.js";
import {
  connectRedis,
  disconnectRedis,
  redisClient,
} from "../src/config/redis.js";
import { User } from "../src/models/user.model.js";

const TEST_DATABASE_NAME = "low_code_platform_test";
const TEST_REDIS_DATABASE = "/15";

/*
 * Safety guards: never run tests against development data.
 */
const assertTestEnvironment = (): void => {
  const mongoPath = new URL(env.MONGO_URI).pathname;

  if (mongoPath !== `/${TEST_DATABASE_NAME}`) {
    throw new Error(
      `Refusing to run tests: MONGO_URI must use database "${TEST_DATABASE_NAME}".`,
    );
  }

  if (new URL(env.REDIS_URL).pathname !== TEST_REDIS_DATABASE) {
    throw new Error(
      `Refusing to run tests: REDIS_URL must use database "${TEST_REDIS_DATABASE}".`,
    );
  }

  if (env.NODE_ENV !== "test") {
    throw new Error("Refusing to run tests: NODE_ENV must be 'test'.");
  }
};

assertTestEnvironment();

const clearTestData = async (): Promise<void> => {
  assertTestEnvironment();

  if (mongoose.connection.name !== TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to clear data in database "${mongoose.connection.name}".`,
    );
  }

  const collections = Object.values(mongoose.connection.collections);

  await Promise.all(
    collections.map((collection) => collection.deleteMany({})),
  );

  await redisClient.flushDb();
};

beforeAll(async () => {
  await connectDatabase();
  await connectRedis();

  // Make sure every collection exists before the first transaction runs.
  // Index building is intentionally not awaited here.
  await Promise.all(
    Object.values(mongoose.models).map(async (model) => {
      try {
        await model.createCollection();
      } catch (error) {
        // 48 = NamespaceExists (collection already created)
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error
            ? error.code
            : undefined;

        if (code !== 48) {
          throw error;
        }
      }
    }),
  );

  // The test database may hold a stale non-unique email_1 index. Email
  // must be globally unique, so rebuild the User indexes from the schema.
  await User.syncIndexes();
});

beforeEach(async () => {
  await clearTestData();
});

afterAll(async () => {
  await clearTestData();
  await disconnectRedis();
  await disconnectDatabase();
});
