import type {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
} from "express";
import { ZodError } from "zod";

import { AppError } from "../utils/errors.js";
import { buildErrorBody } from "../utils/response.js";

/*
 * Express 5 forwards rejected promises and synchronous throws from
 * route handlers to this middleware, so no async wrapper is needed.
 */

const getBodyParserErrorType = (
  error: unknown,
): string | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string"
  ) {
    return error.type;
  }

  return null;
};

/*
 * Client errors raised by Express / body-parser / http-errors carry a
 * numeric 4xx status (for example a malformed URL or an unsupported
 * Content-Encoding). They are the client's fault, so they must not
 * become a 500, and their library-written messages must never be
 * returned.
 */
const getClientErrorStatus = (error: unknown): number | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  for (const key of ["status", "statusCode"] as const) {
    const value: unknown = (error as Record<string, unknown>)[key];

    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 400 &&
      value < 500
    ) {
      return value;
    }
  }

  return null;
};

const CLIENT_ERROR_BODIES: Readonly<
  Record<number, { code: string; message: string }>
> = {
  400: { code: "BAD_REQUEST", message: "Bad request" },
  413: {
    code: "PAYLOAD_TOO_LARGE",
    message: "Request body is too large",
  },
  415: {
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: "Unsupported media type",
  },
};

/*
 * Server-side log line for an unexpected error.
 *
 * Deliberately NOT console.error(error): library errors (MongoDB,
 * nodemailer, Redis, ...) can carry request data, connection details
 * or credentials as extra properties, and those would be dumped into
 * the logs. Only the class, a redacted message, the code and the stack
 * are logged, plus the method and path (never the query string, which
 * can contain tokens).
 */
const REDACTED_DUPLICATE_KEY = /dup key:\s*\{[^}]*\}/gi;
const MAX_LOGGED_MESSAGE_LENGTH = 500;

// V8 starts `stack` with the message, so both must be redacted.
const redact = (value: string): string => {
  return value.replace(REDACTED_DUPLICATE_KEY, "dup key: [redacted]");
};

const logUnhandledError = (error: unknown, req: Request): void => {
  const details =
    error instanceof Error
      ? {
          name: error.name,
          message: redact(error.message).slice(
            0,
            MAX_LOGGED_MESSAGE_LENGTH,
          ),
          code:
            "code" in error &&
            (typeof error.code === "string" ||
              typeof error.code === "number")
              ? error.code
              : undefined,
          stack:
            error.stack === undefined
              ? undefined
              : redact(error.stack),
        }
      : { name: "NonErrorThrown" };

  console.error(
    "❌ Unhandled error:",
    req.method,
    req.path,
    details,
  );
};

const zodErrorToFields = (
  error: ZodError,
): Record<string, string> => {
  const fields: Record<string, string> = {};

  for (const issue of error.issues) {
    const key =
      issue.path.length > 0
        ? issue.path.join(".")
        : "_";

    if (!(key in fields)) {
      fields[key] = issue.message;
    }
  }

  return fields;
};

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res: Response,
  next,
): void => {
  // Once headers are sent the response can no longer be rewritten.
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    res
      .status(400)
      .json(
        buildErrorBody(
          "VALIDATION_ERROR",
          "Invalid request",
          zodErrorToFields(error),
        ),
      );
    return;
  }

  if (error instanceof AppError) {
    res
      .status(error.statusCode)
      .json(
        buildErrorBody(
          error.code,
          error.message,
          error.fields,
        ),
      );
    return;
  }

  const bodyParserErrorType =
    getBodyParserErrorType(error);

  if (bodyParserErrorType === "entity.parse.failed") {
    res
      .status(400)
      .json(
        buildErrorBody(
          "INVALID_JSON",
          "Request body is not valid JSON",
        ),
      );
    return;
  }

  if (bodyParserErrorType === "entity.too.large") {
    res
      .status(413)
      .json(
        buildErrorBody(
          "PAYLOAD_TOO_LARGE",
          "Request body is too large",
        ),
      );
    return;
  }

  const clientErrorStatus = getClientErrorStatus(error);

  if (clientErrorStatus !== null) {
    const body =
      CLIENT_ERROR_BODIES[clientErrorStatus] ??
      CLIENT_ERROR_BODIES[400]!;

    res
      .status(
        clientErrorStatus in CLIENT_ERROR_BODIES
          ? clientErrorStatus
          : 400,
      )
      .json(buildErrorBody(body.code, body.message));
    return;
  }

  // Unexpected error: log it server-side, never expose details.
  logUnhandledError(error, req);

  res
    .status(500)
    .json(
      buildErrorBody(
        "INTERNAL_SERVER_ERROR",
        "An unexpected error occurred",
      ),
    );
};


/*
 * Unknown routes: a JSON body in the standard error format instead of
 * Express's default HTML page. The requested path is not echoed.
 * Register after all routes and before errorHandler.
 */
export const notFoundHandler: RequestHandler = (
  _req,
  res,
): void => {
  res
    .status(404)
    .json(buildErrorBody("NOT_FOUND", "Resource not found"));
};
