import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderHttpClient } from "./http-client.ts";

/** Concrete subclass for testing (ProviderHttpClient methods are protected) */
class TestClient extends ProviderHttpClient {
  doGet<T extends z.ZodType>(path: string, schema: T, params?: Record<string, string>) {
    return this.get(path, schema, params);
  }
  doPost<T extends z.ZodType>(path: string, schema: T, body?: Record<string, unknown>) {
    return this.post(path, schema, body);
  }
  doGetBuffer(url: string) {
    return this.getBuffer(url);
  }
  doGetHeaders() {
    return this.getHeaders();
  }
}

function createMockFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? ""),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
}

describe("ProviderHttpClient", () => {
  describe("constructor", () => {
    it("stores accessToken, apiBase, and fetchFn", () => {
      const fetchFn = vi.fn();
      const client = new TestClient("token123", "https://api.example.com", fetchFn);
      expect(client.doGetHeaders()).toEqual({ Authorization: "Bearer token123" });
    });
  });

  describe("get", () => {
    it("sends GET with Authorization header and validates response", async () => {
      const mockFetch = createMockFetch({ ok: true, body: { id: 1, name: "test" } });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);
      const schema = z.object({ id: z.number(), name: z.string() });

      const result = await client.doGet("/v1/items", schema);

      expect(result).toEqual({ id: 1, name: "test" });
      expect(mockFetch).toHaveBeenCalledWith("https://api.test.com/v1/items", {
        headers: { Authorization: "Bearer tok" },
      });
    });

    it("appends query params to URL", async () => {
      const mockFetch = createMockFetch({ ok: true, body: { ok: true } });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      await client.doGet("/search", z.object({ ok: z.boolean() }), {
        q: "hello",
        page: "2",
      });

      const url = mockFetch.mock.calls[0]?.[0];
      expect(url).toContain("q=hello");
      expect(url).toContain("page=2");
    });

    it("throws on non-OK response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 404,
        text: "Not Found",
      });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      await expect(client.doGet("/missing", z.object({}))).rejects.toThrow(
        "API error 404 on /missing: Not Found",
      );
    });

    it("truncates long error messages", async () => {
      const longText = "x".repeat(600);
      const mockFetch = createMockFetch({
        ok: false,
        status: 500,
        text: longText,
      });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      await expect(client.doGet("/error", z.object({}))).rejects.toThrow(/…$/);
    });

    it("throws ZodError when response fails schema validation", async () => {
      const mockFetch = createMockFetch({ ok: true, body: { wrong: "shape" } });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      await expect(client.doGet("/items", z.object({ id: z.number() }))).rejects.toThrow();
    });
  });

  describe("post", () => {
    it("sends POST with JSON body and validates response", async () => {
      const mockFetch = createMockFetch({ ok: true, body: { created: true } });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      const result = await client.doPost("/v1/items", z.object({ created: z.boolean() }), {
        name: "new item",
      });

      expect(result).toEqual({ created: true });
      const [url, options] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe("https://api.test.com/v1/items");
      expect(options?.method).toBe("POST");
      expect(options?.body).toBe(JSON.stringify({ name: "new item" }));
      expect(options?.headers).toEqual({
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      });
    });

    it("sends POST without body when none provided", async () => {
      const mockFetch = createMockFetch({ ok: true, body: { ok: true } });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      await client.doPost("/v1/action", z.object({ ok: z.boolean() }));

      const [, options] = mockFetch.mock.calls[0] ?? [];
      expect(options?.body).toBeUndefined();
    });
  });

  describe("getBuffer", () => {
    it("returns buffer from response", async () => {
      const data = new Uint8Array([1, 2, 3, 4]);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(data.buffer),
      });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      const result = await client.doGetBuffer("https://cdn.example.com/file.fit");
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it("throws on non-OK response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      });
      const client = new TestClient("tok", "https://api.test.com", mockFetch);

      await expect(client.doGetBuffer("https://cdn.example.com/file.fit")).rejects.toThrow(
        "Failed to download",
      );
    });
  });

  describe("getHeaders (override)", () => {
    it("can be overridden in subclasses", () => {
      class CustomClient extends ProviderHttpClient {
        protected override getHeaders(): Record<string, string> {
          return { ...super.getHeaders(), Accept: "application/json" };
        }
        get testHeaders() {
          return this.getHeaders();
        }
      }
      const client = new CustomClient("tok", "https://api.test.com");
      expect(client.testHeaders).toEqual({
        Authorization: "Bearer tok",
        Accept: "application/json",
      });
    });
  });
});
