import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";

import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import projectRoutes from "./routes/project.routes.js";
import formRoutes from "./routes/form.routes.js";
import publicFormRoutes from "./routes/public-form.routes.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error.middleware.js";
import { isReady } from "./services/health.service.js";
import { RedisRateLimitStore } from "./utils/redis-rate-limit-store.util.js";
import { buildErrorBody } from "./utils/response.js";

const app = express();

/*
 * Behind a reverse proxy (Vercel) req.ip must come from X-Forwarded-For,
 * or every client shares the proxy address and per-IP limits break.
 * Only the configured number of hops is trusted, so a client cannot
 * spoof its address by sending its own header.
 */
app.set("trust proxy", env.TRUST_PROXY_HOPS > 0 ? env.TRUST_PROXY_HOPS : false);

/*
 * Security headers
 */
app.use(helmet());

/*
 * CORS
 */
app.use(
  cors({
    origin: env.CLIENT_URL,
    credentials: true,
    // Read by the client's CSV download.
    exposedHeaders: ["Content-Disposition", "X-Export-Truncated"],
  }),
);

/*
 * Request body parsing
 */
app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  }),
);

/*
 * Cookie parsing
 */
app.use(cookieParser());

/*
 * Basic global rate limiting
 */
const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Shared across instances; if Redis is down the request is let through
  // (the per-route Redis limiters on sensitive endpoints still apply).
  store: new RedisRateLimitStore("global-rate"),
  passOnStoreError: true,
  // Standard error format instead of the library's plain-text body.
  handler: (_req, res) => {
    res
      .status(429)
      .json(
        buildErrorBody(
          "RATE_LIMIT_EXCEEDED",
          "Too many requests. Please try again later.",
        ),
      );
  },
});

app.use(globalRateLimiter);

/*
 * Health check
 */
app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "API is healthy",
  });
});

/*
 * Readiness check
 *
 * Ready only when BOTH MongoDB and Redis answer (and the process is not
 * shutting down). The response never says which dependency failed.
 */
app.get("/ready", async (_req, res) => {
  if (!(await isReady())) {
    res
      .status(503)
      .json(
        buildErrorBody(
          "SERVICE_UNAVAILABLE",
          "API is not ready",
        ),
      );

    return;
  }

  res.status(200).json({
    success: true,
    message: "API is ready",
  });
});

/*
 * Authentication routes
 */
app.use("/api/auth", authRoutes);

/*
 * Project routes
 */
app.use("/api/projects", projectRoutes);

/*
 * Form routes
 */
app.use("/api/forms", formRoutes);

/*
 * Public share-link routes (no authentication)
 */
app.use("/api/public", publicFormRoutes);

/*
 * Unknown routes, then the centralized error handler (must be last)
 */
app.use(notFoundHandler);

app.use(errorHandler);

export default app;