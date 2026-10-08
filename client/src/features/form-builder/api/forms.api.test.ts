import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyFormSchema } from "../utils/form-schema.utils.ts";
import {
  ApiError,
  clearAccessToken,
  fetchForm,
  saveFormDraft,
} from "./forms.api.ts";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refreshOk = (token = "token-1") =>
  json(200, { success: true, data: { accessToken: token } });

const formOk = (extra: Record<string, unknown> = {}) =>
  json(200, {
    success: true,
    data: { form: { _id: FORM_ID, name: "F", status: "DRAFT", ...extra } },
  });

const errorBody = (code: string, message = "msg") => ({
  success: false,
  error: { code, message, fields: {} },
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAccessToken();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const callAt = (index: number) => {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: (init.headers ?? {}) as Record<string, string> };
};

describe("saveFormDraft", () => {
  it("PATCHes only draftSchema, authenticated with a refreshed access token", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk("abc"));
    fetchMock.mockResolvedValueOnce(formOk());
    const schema = createEmptyFormSchema();

    await saveFormDraft(FORM_ID, schema);

    const refresh = callAt(0);
    expect(refresh.url).toMatch(/\/auth\/refresh$/);
    expect(refresh.init.method).toBe("POST");
    expect(refresh.init.credentials).toBe("include");

    const patch = callAt(1);
    expect(patch.url).toMatch(new RegExp(`/forms/${FORM_ID}$`));
    expect(patch.init.method).toBe("PATCH");
    expect(patch.headers.Authorization).toBe("Bearer abc");
    expect(patch.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(patch.init.body as string)).toEqual({
      draftSchema: schema,
    });
  });

  it("reuses the in-memory token for later requests", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk("abc"));
    fetchMock.mockResolvedValue(formOk());

    await saveFormDraft(FORM_ID, createEmptyFormSchema());
    await saveFormDraft(FORM_ID, createEmptyFormSchema());

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(callAt(2).url).toMatch(/\/forms\//);
  });

  it("refreshes the token once and retries on a 401", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk("old"));
    fetchMock.mockResolvedValueOnce(json(401, errorBody("UNAUTHORIZED")));
    fetchMock.mockResolvedValueOnce(refreshOk("new"));
    fetchMock.mockResolvedValueOnce(formOk());

    await saveFormDraft(FORM_ID, createEmptyFormSchema());

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(callAt(3).headers.Authorization).toBe("Bearer new");
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "FORM_NOT_FOUND"],
    [400, "VALIDATION_ERROR"],
    [413, "PAYLOAD_TOO_LARGE"],
    [500, "INTERNAL_ERROR"],
  ])("maps a %i response to an ApiError", async (status, code) => {
    fetchMock.mockResolvedValue(refreshOk());
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(status, errorBody(code, "boom")));
    // A 401 triggers one refresh + retry; make the retry fail the same way.
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(status, errorBody(code, "boom")));

    const error = await saveFormDraft(FORM_ID, createEmptyFormSchema()).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code, message: "boom" });
  });

  it("maps a network failure to a NETWORK_ERROR ApiError", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await saveFormDraft(FORM_ID, createEmptyFormSchema()).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("fails with 401 when there is no session to refresh", async () => {
    fetchMock.mockResolvedValue(json(401, errorBody("UNAUTHORIZED")));

    const error = await saveFormDraft(FORM_ID, createEmptyFormSchema()).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ status: 401 });
  });

  it("does not leak server internals into error messages it invents", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 502 }));

    const error = await saveFormDraft(FORM_ID, createEmptyFormSchema()).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ status: 502, code: "REQUEST_FAILED" });
    expect((error as Error).message).toBe("Request failed");
  });
});

describe("fetchForm", () => {
  it("returns the form with its untrusted draft", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      formOk({ draftSchema: { version: 1, fields: [] } }),
    );

    const form = await fetchForm(FORM_ID);

    expect(form).toEqual({
      id: FORM_ID,
      name: "F",
      description: "",
      status: "DRAFT",
      draftSchema: { version: 1, fields: [] },
    });
    expect(callAt(1).init.method).toBeUndefined();
  });

  it("returns an undefined draft when none is saved", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(formOk());

    expect((await fetchForm(FORM_ID)).draftSchema).toBeUndefined();
  });

  it("rejects an unexpected response shape", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: {} }));

    await expect(fetchForm(FORM_ID)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("URL-encodes the form id", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(formOk());

    await fetchForm("a/b?c");

    expect(callAt(1).url).toMatch(/\/forms\/a%2Fb%3Fc$/);
  });
});
