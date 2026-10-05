import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, clearAccessToken, publishForm } from "./forms.api.ts";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refreshOk = () => json(200, { success: true, data: { accessToken: "tok" } });

const published = {
  formId: FORM_ID,
  versionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 2,
  status: "PUBLISHED",
  publishedAt: "2026-10-05T10:00:00.000Z",
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

describe("publishForm", () => {
  it("POSTs to /forms/:id/publish with no body and a Bearer token", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: published }));

    const result = await publishForm(FORM_ID);

    expect(result).toEqual(published);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/forms/${FORM_ID}/publish$`));
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    // The client never sends an organization, version or schema.
    expect(JSON.stringify(init)).not.toMatch(/organizationId|draftSchema/);
  });

  it("throws an ApiError carrying the code and field messages", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(400, {
        success: false,
        error: {
          code: "FORM_SCHEMA_INVALID",
          message: "invalid",
          fields: { "fields.0.label": "Field label is required" },
        },
      }),
    );

    const error = await publishForm(FORM_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "FORM_SCHEMA_INVALID",
      fields: { "fields.0.label": "Field label is required" },
    });
  });

  it("rejects an unexpected success body instead of pretending it worked", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: { formId: FORM_ID } }));

    await expect(publishForm(FORM_ID)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("maps a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));

    await expect(publishForm(FORM_ID)).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
    });
  });
});
