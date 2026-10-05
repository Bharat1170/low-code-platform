import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearAccessToken, submitForm } from "./forms.api.ts";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refreshOk = () => json(200, { success: true, data: { accessToken: "tok" } });

const receipt = {
  id: "665f1c2e8f1b2c3d4e5f6aaa",
  formId: FORM_ID,
  formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 2,
  submittedAt: "2026-10-05T10:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAccessToken();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitForm", () => {
  it("POSTs only { data } to /forms/:id/submissions", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(201, { success: true, data: { submission: receipt } }));

    const result = await submitForm(FORM_ID, { name: "Ada", terms: true });

    expect(result).toEqual(receipt);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain(`/forms/${FORM_ID}/submissions`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      data: { name: "Ada", terms: true },
    });
  });

  it("surfaces per-field validation messages", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(400, {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "The submission is not valid",
          fields: { name: "Name is required" },
        },
      }),
    );

    const error = await submitForm(FORM_ID, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("VALIDATION_ERROR");
    expect((error as ApiError).fields).toEqual({ name: "Name is required" });
  });

  it("rejects an unexpected response shape", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(201, { success: true, data: {} }));

    await expect(submitForm(FORM_ID, {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
