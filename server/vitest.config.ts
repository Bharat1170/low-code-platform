import { defineConfig } from "vitest/config";

/*
 * Test environment.
 *
 * These values are set explicitly so the tests never fall back to the
 * development MONGO_URI / REDIS_URL from .env (dotenv does not override
 * variables that are already set). tests/setup.ts additionally refuses to
 * run if the resolved URIs do not point at the dedicated test databases.
 *
 * The secrets below are throwaway values used only by the test suite.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: "test",
      PORT: "5099",
      MONGO_URI:
        "mongodb://127.0.0.1:27017/low_code_platform_test?replicaSet=rs0",
      REDIS_URL: "redis://127.0.0.1:6379/15",
      JWT_ACCESS_SECRET:
        "test-only-access-secret-0123456789abcdef-0123456789",
      JWT_REFRESH_SECRET:
        "test-only-refresh-secret-0123456789abcdef-012345678",
      JWT_ACCESS_EXPIRES_IN: "15m",
      JWT_REFRESH_EXPIRES_IN: "7d",
      CLIENT_URL: "http://localhost:5173",
      EMAIL_HOST: "localhost",
      EMAIL_PORT: "1025",
      EMAIL_USER: "test@example.com",
      EMAIL_PASSWORD: "test-only-password",
    },
  },
});
