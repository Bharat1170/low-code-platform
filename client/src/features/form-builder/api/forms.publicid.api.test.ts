// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidPublicId, publicFormPath, publicFormUrl } from "../utils/share-url.ts";
import { clearAccessToken, fetchForm, fetchPublicId } from "./forms.api.ts";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const PUBLIC_ID = "Ab3_-Zy9Xw8Vu7Ts6Rq5Pn4M";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const formBody = (extra: Record<string, unknown>) =>
  json(200, {
    success: true,
    data: { form: { _id: FORM_ID, name: "F", status: "PUBLISHED", ...extra } },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearAccessToken();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValueOnce(
    json(200, { success: true, data: { accessToken: "tok" } }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publicId from the form API", () => {
  it("is returned by fetchForm when it has the generated shape", async () => {
    fetchMock.mockResolvedValueOnce(formBody({ publicId: PUBLIC_ID }));
    expect((await fetchForm(FORM_ID)).publicId).toBe(PUBLIC_ID);
  });

  it("is ignored when it is missing or malformed", async () => {
    for (const publicId of [undefined, "", "short", "has spaces in it 1234567", 42, null]) {
      fetchMock.mockResolvedValueOnce(formBody({ publicId }));
      expect("publicId" in (await fetchForm(FORM_ID))).toBe(false);
    }
  });

  it("fetchPublicId resolves the id, or null when there is none", async () => {
    fetchMock.mockResolvedValueOnce(formBody({ publicId: PUBLIC_ID }));
    expect(await fetchPublicId(FORM_ID)).toBe(PUBLIC_ID);

    fetchMock.mockResolvedValueOnce(formBody({}));
    expect(await fetchPublicId(FORM_ID)).toBeNull();
  });
});

describe("public URL", () => {
  it("is /f/<publicId> on the app's own origin", () => {
    expect(publicFormPath(PUBLIC_ID)).toBe(`/f/${PUBLIC_ID}`);
    expect(publicFormUrl(PUBLIC_ID, "https://example.test")).toBe(
      `https://example.test/f/${PUBLIC_ID}`,
    );
    expect(publicFormUrl(PUBLIC_ID)).toBe(`${window.location.origin}/f/${PUBLIC_ID}`);
  });

  it("refuses anything that is not a generated public id", () => {
    for (const bad of ["", "abc", `${PUBLIC_ID}x`, "../etc/passwd/../../xxxxxxx", "a b"]) {
      expect(isValidPublicId(bad)).toBe(false);
      expect(() => publicFormPath(bad)).toThrow();
    }
  });
});
