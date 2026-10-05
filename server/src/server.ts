import app from "./app.js";
import { env } from "./config/env.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./config/database.js";
import {
  connectRedis,
  disconnectRedis,
} from "./config/redis.js";
import { markShuttingDown } from "./services/health.service.js";
// import { verifyEmailConnection } from "./services/email.service.js";

const startServer = async (): Promise<void> => {
  try {
    await connectDatabase();
    await connectRedis();
    // await verifyEmailConnection();

    const server = app.listen(env.PORT, () => {
      console.log(`🚀 API server running on port ${env.PORT}`);
      console.log(`Environment: ${env.NODE_ENV}`);
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\n${signal} received. Shutting down gracefully...`);

      // Fail readiness first so traffic is drained before connections close.
      markShuttingDown();

      server.close(async () => {
        try {
          await disconnectRedis();
          await disconnectDatabase();

          console.log("✅ Server shutdown complete");
          process.exit(0);
        } catch (error) {
          console.error("❌ Error during shutdown:", error);
          process.exit(1);
        }
      });
    };

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

void startServer();