import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  authorizedRequest,
  clearAccessToken,
  refreshAccessToken,
  setAccessToken,
  setAuthFailureHandler,
} from "./http.ts";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refreshOk = (token: string) =>
  json(200, { success: true, data: { accessToken: token } });

const unauthorized = () =>
  json(401, {
    success: false,
    error: { code: "UNAUTHORIZED", message: "no", fields: {} },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAccessToken();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  setAuthFailureHandler(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const paths = () =>
  fetchMock.mock.calls.map(([url]) => String(url).replace(/^.*\/api/, ""));

describe("token refresh", () => {
  it("sends the refresh request with credentials", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk("t1"));

    await refreshAccessToken();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
  });

  it("a 401 triggers exactly one refresh and retries the request", async () => {
    setAccessToken("expired");
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(refreshOk("fresh"))
      .mockResolvedValueOnce(json(200, { success: true, data: { ok: 1 } }));

    const body = await authorizedRequest("/thing");

    expect(body).toMatchObject({ data: { ok: 1 } });
    expect(paths()).toEqual(["/thing", "/auth/refresh", "/thing"]);

    const [, retry] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retry.headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh",
    );
  });

  it("does not loop when the retried request is still a 401", async () => {
    setAccessToken("expired");
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(refreshOk("fresh"))
      .mockResolvedValueOnce(unauthorized());

    await expect(authorizedRequest("/thing")).rejects.toMatchObject({
      status: 401,
    });

    // request, ONE refresh, retry. Nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a failed refresh signs the user out and does not retry", async () => {
    const onFailure = vi.fn();
    setAuthFailureHandler(onFailure);
    setAccessToken("expired");
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized());

    await expect(authorizedRequest("/thing")).rejects.toMatchObject({
      status: 401,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(paths()).toEqual(["/thing", "/auth/refresh"]);

    // The token was dropped: the next call must refresh again.
    fetchMock.mockResolvedValueOnce(unauthorized());
    await expect(authorizedRequest("/thing")).rejects.toBeInstanceOf(ApiError);
    expect(paths()[2]).toBe("/auth/refresh");
  });

  it("a network failure during refresh is not treated as a sign-out", async () => {
    const onFailure = vi.fn();
    setAuthFailureHandler(onFailure);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));

    await expect(refreshAccessToken()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });

    expect(onFailure).not.toHaveBeenCalled();
  });

  it("concurrent requests share one refresh", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith("/auth/refresh")) return refreshOk("shared");
      return json(200, { success: true, data: {} });
    });

    await Promise.all([authorizedRequest("/a"), authorizedRequest("/b")]);

    expect(paths().filter((p) => p === "/auth/refresh")).toHaveLength(1);
  });
});

describe("request failures", () => {
  it("times out instead of hanging", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    const pending = refreshAccessToken().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_001);

    expect(await pending).toMatchObject({ status: 0, code: "TIMEOUT" });
  });

  it("exposes field errors from the standard error body", async () => {
    setAccessToken("t");
    fetchMock.mockResolvedValueOnce(
      json(400, {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "bad",
          fields: { email: "Invalid email address" },
        },
      }),
    );

    await expect(authorizedRequest("/x")).rejects.toMatchObject({
      status: 400,
      fields: { email: "Invalid email address" },
    });
  });
});
