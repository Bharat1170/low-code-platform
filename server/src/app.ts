import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";

import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import projectRoutes from "./routes/project.routes.js";
import formRoutes from "./routes/form.routes.js";
import {
  errorHandler,
  notFoundHandler,
} from "./middleware/error.middleware.js";
import { isReady } from "./services/health.service.js";
import { buildErrorBody } from "./utils/response.js";

const app = express();

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
 * Unknown routes, then the centralized error handler (must be last)
 */
app.use(notFoundHandler);

app.use(errorHandler);

export default app;