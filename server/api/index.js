import app from "../dist/app.js";
import { connectDatabase } from "../dist/config/database.js";
import { connectRedis } from "../dist/config/redis.js";
import { buildErrorBody } from "../dist/utils/response.js";

/*
 * Vercel entrypoint. src/server.ts (listener + graceful shutdown) is not
 * used on Vercel; this adapter performs the same connection setup once per
 * function instance and then delegates every request to the existing app.
 * It imports the output of `npm run build`, so the project's own tsc
 * compiles the sources, not Vercel.
 *
 * The in-flight promise is shared, so concurrent first requests connect
 * once and warm invocations skip it. A failed attempt is not cached, so
 * the next request retries.
 */
let initialization = null;

const initialize = () => {
  initialization ??= (async () => {
    await connectDatabase();
    await connectRedis();
  })().catch((error) => {
    initialization = null;
    throw error;
  });

  return initialization;
};

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export default async function handler(req, res) {
  try {
    await initialize();
  } catch {
    // Details are already logged by the connect functions; never leak them.
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify(
        buildErrorBody("SERVICE_UNAVAILABLE", "API is not ready"),
      ),
    );
    return;
  }

  app(req, res);
}
