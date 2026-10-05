import mongoose from "mongoose";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/app.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "../src/config/database.js";
import {
  connectRedis,
  disconnectRedis,
  redisClient,
} from "../src/config/redis.js";
import { markShuttingDown } from "../src/services/health.service.js";

/*
 * Real disconnect / reconnect against the isolated test MongoDB and
 * Redis (tests/setup.ts refuses to run against anything else). Every
 * test restores both connections, because setup.ts clears data between
 * tests and after the suite.
 */
const restoreConnections = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 1) {
    await connectDatabase();
  }

  if (!redisClient.isReady) {
    if (redisClient.isOpen) {
      await disconnectRedis();
    }

    await connectRedis();
  }
};

/*
 * Temporarily overrides an accessor that is inherited from a prototype
 * (mongoose.connection.readyState, redisClient.isReady). vi.spyOn on such
 * accessors is not reliably undone by restoreAllMocks, so the override is
 * an own property that is deleted again, which re-exposes the original
 * prototype getter exactly.
 */
const withOverriddenGetter = async (
  target: object,
  key: string,
  value: unknown,
  run: () => Promise<void>,
): Promise<void> => {
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => value,
  });

  try {
    await run();
  } finally {
    delete (target as Record<string, unknown>)[key];
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await restoreConnections();
});

/*
 * Nothing about the infrastructure may reach a client.
 */
const expectNoInfrastructureDetails = (value: unknown): void => {
  const raw = JSON.stringify(value).toLowerCase();

  for (const forbidden of [
    "mongo",
    "redis",
    "27017",
    "6379",
    "127.0.0.1",
    "localhost",
    "replicaset",
    "rs0",
    "low_code_platform",
    "econnrefused",
    "timed out",
    "timeout",
    "stack",
    "password",
    "secret",
    "mongodb://",
    "redis://",
    "node_modules",
    "at ",
  ]) {
    expect(raw).not.toContain(forbidden);
  }
};

const expectNotReady = (res: request.Response): void => {
  expect(res.status).toBe(503);
  expect(res.body).toEqual({
    success: false,
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "API is not ready",
      fields: {},
    },
  });
  expectNoInfrastructureDetails(res.body);
};

const expectReady = (res: request.Response): void => {
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    success: true,
    message: "API is ready",
  });
};

const expectHealthy = (res: request.Response): void => {
  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    success: true,
    message: "API is healthy",
  });
};

describe("GET /health (liveness)", () => {
  it("returns 200 when MongoDB and Redis are healthy", async () => {
    expectHealthy(await request(app).get("/health"));
  });

  it("still returns 200 when MongoDB is unavailable", async () => {
    await disconnectDatabase();

    expectHealthy(await request(app).get("/health"));
  });

  it("still returns 200 when Redis is unavailable", async () => {
    await disconnectRedis();

    expectHealthy(await request(app).get("/health"));
  });

  it("still returns 200 when both are unavailable, without touching them", async () => {
    await disconnectDatabase();
    await disconnectRedis();

    const ping = vi.spyOn(redisClient, "ping");

    const res = await request(app).get("/health");

    expectHealthy(res);
    expect(ping).not.toHaveBeenCalled();
    expectNoInfrastructureDetails(res.body);
  });
});

describe("GET /ready (readiness)", () => {
  it("returns 200 when MongoDB and Redis are healthy", async () => {
    expectReady(await request(app).get("/ready"));
  });

  it("returns 503 when MongoDB is unavailable", async () => {
    await disconnectDatabase();

    expectNotReady(await request(app).get("/ready"));
  });

  it("returns 503 when Redis is unavailable", async () => {
    await disconnectRedis();

    expectNotReady(await request(app).get("/ready"));
  });

  it("returns 503 when both are unavailable", async () => {
    await disconnectDatabase();
    await disconnectRedis();

    expectNotReady(await request(app).get("/ready"));
  });

  it("gives the same response whichever dependency is down", async () => {
    await disconnectDatabase();
    const mongoDown = await request(app).get("/ready");
    await restoreConnections();

    await disconnectRedis();
    const redisDown = await request(app).get("/ready");

    expect(mongoDown.body).toEqual(redisDown.body);
    expect(mongoDown.status).toBe(redisDown.status);
  });

  it("recovers to 200 after MongoDB reconnects", async () => {
    await disconnectDatabase();
    expectNotReady(await request(app).get("/ready"));

    await connectDatabase();
    expectReady(await request(app).get("/ready"));
  });

  it("recovers to 200 after Redis reconnects", async () => {
    await disconnectRedis();
    expectNotReady(await request(app).get("/ready"));

    await connectRedis();
    expectReady(await request(app).get("/ready"));
  });

  it("recovers after both dependencies come back", async () => {
    await disconnectDatabase();
    await disconnectRedis();
    expectNotReady(await request(app).get("/ready"));

    await connectDatabase();
    expectNotReady(await request(app).get("/ready"));

    await connectRedis();
    expectReady(await request(app).get("/ready"));
  });

  it("is not ready while MongoDB is still connecting", async () => {
    await withOverriddenGetter(
      mongoose.connection,
      "readyState",
      mongoose.ConnectionStates.connecting,
      async () => {
        expectNotReady(await request(app).get("/ready"));
      },
    );

    expectReady(await request(app).get("/ready"));
  });

  it("is not ready while Redis is open but not ready (reconnecting)", async () => {
    await withOverriddenGetter(
      redisClient,
      "isReady",
      false,
      async () => {
        expectNotReady(await request(app).get("/ready"));
      },
    );

    expectReady(await request(app).get("/ready"));
  });

  it("is not ready when MongoDB reports connected but does not answer a ping", async () => {
    const db = mongoose.connection.db;

    if (!db) {
      throw new Error("Test database is not connected");
    }

    vi.spyOn(db, "admin").mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error("ping failed")),
    } as unknown as ReturnType<typeof db.admin>);

    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expectNotReady(await request(app).get("/ready"));
  });

  it("is not ready when Redis reports ready but does not answer a ping", async () => {
    vi.spyOn(redisClient, "ping").mockRejectedValue(
      new Error("ping failed"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expectNotReady(await request(app).get("/ready"));
  });

  it("is not ready, and does not hang, when a dependency never answers", async () => {
    vi.spyOn(redisClient, "ping").mockReturnValue(
      new Promise(() => undefined) as ReturnType<
        typeof redisClient.ping
      >,
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const started = Date.now();
    const res = await request(app).get("/ready");
    const elapsed = Date.now() - started;

    expectNotReady(res);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(5000);
  });

  it("returns 503 rather than crashing on an unexpected error in a check", async () => {
    const db = mongoose.connection.db;

    if (!db) {
      throw new Error("Test database is not connected");
    }

    vi.spyOn(db, "admin").mockImplementation(() => {
      throw new Error("unexpected internal failure");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expectNotReady(await request(app).get("/ready"));

    // The server keeps serving afterwards.
    vi.restoreAllMocks();
    expectReady(await request(app).get("/ready"));
  });
});

describe("readiness failures do not leak infrastructure details", () => {
  it("never returns dependency error messages, URLs or credentials", async () => {
    vi.spyOn(redisClient, "ping").mockRejectedValue(
      Object.assign(
        new Error(
          "connect ECONNREFUSED redis://:SUPER-SECRET@redis.internal:6379",
        ),
        { stack: "Error: at /srv/app/node_modules/redis/index.js:1:1" },
      ),
    );

    const db = mongoose.connection.db;

    if (!db) {
      throw new Error("Test database is not connected");
    }

    vi.spyOn(db, "admin").mockReturnValue({
      ping: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "MongoServerSelectionError mongodb://user:DB-PASS@mongo.internal:27017/prod",
          ),
        ),
    } as unknown as ReturnType<typeof db.admin>);

    const spy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const res = await request(app).get("/ready");

    expectNotReady(res);

    for (const secret of [
      "SUPER-SECRET",
      "DB-PASS",
      "redis.internal",
      "mongo.internal",
      "/srv/app",
    ]) {
      expect(res.text).not.toContain(secret);
      expect(JSON.stringify(res.headers)).not.toContain(secret);
    }

    // Server-side logs name the dependency and the error class only.
    const logged = JSON.stringify(spy.mock.calls);

    expect(logged).toContain("mongodb");
    expect(logged).toContain("redis");

    for (const secret of [
      "SUPER-SECRET",
      "DB-PASS",
      "redis.internal",
      "mongo.internal",
      "ECONNREFUSED",
      "/srv/app",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("uses the standard error format and no authentication", async () => {
    await disconnectRedis();

    const res = await request(app).get("/ready");

    // No Authorization header was sent and it is still answered.
    expect(res.status).toBe(503);
    expect(Object.keys(res.body).sort()).toEqual(["error", "success"]);
    expect(Object.keys(res.body.error).sort()).toEqual([
      "code",
      "fields",
      "message",
    ]);
  });

  it("does not expose connection details in /health or /ready success bodies", async () => {
    expectNoInfrastructureDetails(
      (await request(app).get("/health")).body,
    );

    const ready = await request(app).get("/ready");
    expect(Object.keys(ready.body).sort()).toEqual([
      "message",
      "success",
    ]);
    expectNoInfrastructureDetails(ready.body);
  });
});

/*
 * markShuttingDown() is process-wide and permanent, so this must stay
 * the last test in the file.
 */
describe("shutdown", () => {
  it("reports not ready as soon as graceful shutdown starts, while staying alive", async () => {
    expectReady(await request(app).get("/ready"));

    markShuttingDown();

    expectNotReady(await request(app).get("/ready"));
    expectHealthy(await request(app).get("/health"));
  });
});
