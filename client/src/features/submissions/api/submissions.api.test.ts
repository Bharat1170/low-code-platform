import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessToken } from "../../../lib/http.ts";
import { ApiError, deleteSubmission, getSubmission, listSubmissions } from "./submissions.api.ts";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";
const SUB_ID = "665f1c2e8f1b2c3d4e5f6aaa";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refreshOk = () => json(200, { success: true, data: { accessToken: "tok" } });

const item = {
  id: SUB_ID,
  formId: FORM_ID,
  formVersionId: "665f1c2e8f1b2c3d4e5f6a99",
  version: 2,
  submittedBy: "665f1c2e8f1b2c3d4e5f6a01",
  submittedByName: "Ada Lovelace",
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

describe("listSubmissions", () => {
  it("GETs the list with only the supported, defined params", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(200, {
        success: true,
        data: {
          items: [item],
          pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 },
        },
      }),
    );

    const result = await listSubmissions(FORM_ID, {
      page: 2,
      pageSize: 10,
      version: undefined,
      submittedFrom: "2026-01-01",
    });

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toContain(`/forms/${FORM_ID}/submissions?`);
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=10");
    expect(url).toContain("submittedFrom=2026-01-01");
    expect(url).not.toContain("version");
    expect(init.method ?? "GET").toBe("GET");
    expect(result.items).toEqual([item]);
    expect(result.pagination.totalPages).toBe(2);
  });

  it("sends no query string without params", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(200, {
        success: true,
        data: {
          items: [],
          pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
        },
      }),
    );

    await listSubmissions(FORM_ID);

    expect((fetchMock.mock.calls[1] as [string])[0]).toMatch(/submissions$/);
  });

  it("surfaces API errors and rejects malformed responses", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(403, {
        success: false,
        error: { code: "FORBIDDEN", message: "x", fields: {} },
      }),
    );
    await expect(listSubmissions(FORM_ID)).rejects.toMatchObject({ status: 403 });

    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: { items: [{}] } }));
    await expect(listSubmissions(FORM_ID)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("getSubmission", () => {
  const schema = {
    version: 1,
    fields: [
      {
        id: "name",
        type: "TEXT",
        label: "Customer Name",
        description: "",
        required: false,
        config: { placeholder: "", defaultValue: "" },
        validation: {},
        conditionalLogic: null,
      },
    ],
  };

  it("GETs one submission and validates the schema", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(200, {
        success: true,
        data: {
          submission: { ...item, formName: "Contact", data: { name: "Bharat" }, schema },
        },
      }),
    );

    const result = await getSubmission(FORM_ID, SUB_ID);

    expect((fetchMock.mock.calls[1] as [string])[0]).toContain(
      `/forms/${FORM_ID}/submissions/${SUB_ID}`,
    );
    expect(result.data).toEqual({ name: "Bharat" });
    expect(result.schema?.fields[0].label).toBe("Customer Name");
    expect(result.formName).toBe("Contact");
  });

  it("degrades an invalid or missing schema to null", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(200, {
        success: true,
        data: { submission: { ...item, data: { a: "1" }, schema: { nope: true } } },
      }),
    );

    expect((await getSubmission(FORM_ID, SUB_ID)).schema).toBeNull();
  });

  it("surfaces 404", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(404, {
        success: false,
        error: { code: "SUBMISSION_NOT_FOUND", message: "x", fields: {} },
      }),
    );

    await expect(getSubmission(FORM_ID, SUB_ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteSubmission", () => {
  it("sends DELETE to the form's submission path with credentials and a bearer token", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(json(200, { success: true, message: "ok" }));

    await expect(deleteSubmission(FORM_ID, SUB_ID)).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/forms/${FORM_ID}/submissions/${SUB_ID}$`));
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init.body).toBeUndefined();
  });

  it("encodes ids and surfaces API errors", async () => {
    fetchMock.mockResolvedValueOnce(refreshOk());
    fetchMock.mockResolvedValueOnce(
      json(403, { success: false, error: { code: "FORBIDDEN", message: "x", fields: {} } }),
    );

    await expect(deleteSubmission("a/b", "c?d")).rejects.toBeInstanceOf(ApiError);
    expect((fetchMock.mock.calls[1] as [string])[0]).toContain("/forms/a%2Fb/submissions/c%3Fd");
  });
});
