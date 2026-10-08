/*
 * Shared HTTP layer built on fetch. Used by the auth API and the form API
 * so the whole app has ONE in-memory access token and ONE refresh flow.
 *
 * The access token lives only in this module's memory (never localStorage
 * or sessionStorage). The refresh token is an httpOnly cookie that
 * JavaScript cannot read; it is sent with `credentials: "include"`.
 */

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "https://low-code-platform-server.vercel.app/api";

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /* Per-field messages from the standard error body, when present. */
  readonly fields: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<string> | null = null;
let authFailureHandler: (() => void) | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

export const clearAccessToken = (): void => {
  accessToken = null;
  refreshInFlight = null;
};

/*
 * Registered by AuthProvider. Called when the session can no longer be
 * refreshed (the server rejected the refresh), so the UI can sign out.
 * Returns an unsubscribe function.
 */
export const setAuthFailureHandler = (
  handler: (() => void) | null,
): (() => void) => {
  authFailureHandler = handler;
  return () => {
    if (authFailureHandler === handler) {
      authFailureHandler = null;
    }
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const readEnvelope = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

const readFields = (value: unknown): Record<string, string> => {
  const fields: Record<string, string> = {};

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const message = Array.isArray(entry) ? entry[0] : entry;
      if (typeof message === "string") {
        fields[key] = message;
      }
    }
  }

  return fields;
};

export const toApiError = (status: number, body: unknown): ApiError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
  const message =
    typeof error?.message === "string" ? error.message : "Request failed";

  return new ApiError(status, code, message, readFields(error?.fields));
};

/* Low-level fetch. Network failures and timeouts become ApiErrors. */
export const send = async (
  path: string,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include",
      signal: controller.signal,
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, "TIMEOUT", "The request timed out");
    }
    throw new ApiError(0, "NETWORK_ERROR", "Unable to reach the server");
  } finally {
    clearTimeout(timer);
  }
};

const jsonHeaders = (init: RequestInit): Record<string, string> =>
  init.body === undefined ? {} : { "Content-Type": "application/json" };

/*
 * Request without an access token (register, login, logout, ...).
 * Returns the parsed body or throws an ApiError.
 */
export const publicRequest = async (
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const response = await send(path, {
    ...init,
    headers: jsonHeaders(init),
  });
  const body = await readEnvelope(response);

  if (!response.ok) {
    throw toApiError(response.status, body);
  }

  return body;
};

/*
 * Exchanges the refresh cookie for a new access token. Concurrent callers
 * share one request, because refresh tokens rotate and a second parallel
 * use of the same cookie would look like token reuse to the server.
 * When the server rejects the refresh, the session is gone: the token is
 * dropped and the auth failure handler runs.
 */
export const refreshAccessToken = (): Promise<string> => {
  refreshInFlight ??= (async () => {
    try {
      const response = await send("/auth/refresh", { method: "POST" });
      const body = await readEnvelope(response);

      if (!response.ok) {
        throw toApiError(response.status, body);
      }

      const token =
        isRecord(body) && isRecord(body.data) ? body.data.accessToken : null;

      if (typeof token !== "string" || token === "") {
        throw new ApiError(401, "UNAUTHORIZED", "Not signed in");
      }

      accessToken = token;
      return token;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        accessToken = null;
        authFailureHandler?.();
      }
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
};

/*
 * The raw Response of an authenticated request, with the same token and
 * single refresh-and-retry handling as authorizedRequest. For non-JSON
 * bodies (e.g. a CSV download); the caller checks response.ok.
 */
export const authorizedFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const attempt = (token: string): Promise<Response> =>
    send(path, {
      ...init,
      headers: {
        ...jsonHeaders(init),
        Authorization: `Bearer ${token}`,
      },
    });

  const response = await attempt(accessToken ?? (await refreshAccessToken()));

  return response.status === 401
    ? attempt(await refreshAccessToken())
    : response;
};

/*
 * Authenticated request. Uses the in-memory token (refreshing first if
 * there is none) and, on a 401, refreshes ONCE and retries ONCE. A second
 * 401 is returned as an error: there is no refresh loop.
 */
export const authorizedRequest = async (
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const response = await authorizedFetch(path, init);
  const body = await readEnvelope(response);

  if (!response.ok) {
    throw toApiError(response.status, body);
  }

  return body;
};
