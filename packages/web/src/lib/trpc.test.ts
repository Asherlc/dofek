import { beforeEach, describe, expect, it, vi } from "vitest";

const httpBatchStreamLinkMock = vi.fn((options: unknown) => ({
  type: "stream",
  options,
}));
const httpBatchLinkMock = vi.fn((options: unknown) => ({
  type: "batch",
  options,
}));
const splitLinkMock = vi.fn((options: unknown) => ({
  type: "split",
  options,
}));
const createClientMock = vi.fn(() => ({
  __type: "mock-client",
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFunction(value: unknown): value is (...parameters: ReadonlyArray<unknown>) => unknown {
  return typeof value === "function";
}

function readObjectProperty(parent: unknown, key: string): unknown {
  if (!isRecord(parent)) {
    throw new Error("Expected an object while reading test value");
  }
  return Reflect.get(parent, key);
}

vi.mock("@trpc/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@trpc/client")>();
  return {
    ...original,
    httpBatchStreamLink: httpBatchStreamLinkMock,
    httpBatchLink: httpBatchLinkMock,
    splitLink: splitLinkMock,
  };
});

vi.mock("@trpc/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@trpc/react-query")>();
  return {
    ...original,
    createTRPCReact: vi.fn(() => ({ createClient: createClientMock })),
  };
});

describe("createTRPCClient", () => {
  beforeEach(() => {
    httpBatchStreamLinkMock.mockClear();
    httpBatchLinkMock.mockClear();
    splitLinkMock.mockClear();
    createClientMock.mockClear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("configures split link routing and shared link options", async () => {
    const { createTRPCClient } = await import("./trpc.ts");

    createTRPCClient();

    expect(httpBatchStreamLinkMock).toHaveBeenCalledTimes(1);
    expect(httpBatchLinkMock).toHaveBeenCalledTimes(1);
    expect(splitLinkMock).toHaveBeenCalledTimes(1);
    expect(createClientMock).toHaveBeenCalledTimes(1);

    const splitOptions = splitLinkMock.mock.calls[0]?.[0];
    expect(splitOptions).toMatchObject({
      true: { type: "batch" },
      false: { type: "stream" },
    });

    const condition = readObjectProperty(splitOptions, "condition");
    expect(typeof condition).toBe("function");
    if (typeof condition !== "function") {
      throw new Error("splitLink condition must be a function");
    }
    expect(condition({ type: "mutation" })).toBe(true);
    expect(condition({ type: "query" })).toBe(false);

    const batchLinkOptions = httpBatchLinkMock.mock.calls[0]?.[0];
    const streamLinkOptions = httpBatchStreamLinkMock.mock.calls[0]?.[0];
    for (const linkOptions of [batchLinkOptions, streamLinkOptions]) {
      expect(readObjectProperty(linkOptions, "url")).toBe("/api/trpc");
      expect(readObjectProperty(linkOptions, "methodOverride")).toBe("POST");
      const headers = readObjectProperty(linkOptions, "headers");
      expect(typeof headers).toBe("function");
      if (!isFunction(headers)) {
        throw new Error("Expected headers to be a function");
      }
      const headersResult = headers();
      expect(headersResult).toHaveProperty("x-timezone");
      expect(typeof readObjectProperty(headersResult, "x-timezone")).toBe("string");
      const fetchImplementation = readObjectProperty(linkOptions, "fetch");
      expect(typeof fetchImplementation).toBe("function");
    }
  });

  it("mutation link fetch uses credentials and redirects only on 401", async () => {
    const fetchMock = vi
      .fn<(requestUrl: RequestInfo | URL, requestOptions?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { href: "/dashboard" } });

    const { createTRPCClient } = await import("./trpc.ts");
    createTRPCClient();

    const batchLinkOptions = httpBatchLinkMock.mock.calls[0]?.[0];
    const batchFetch = readObjectProperty(batchLinkOptions, "fetch");
    if (!isFunction(batchFetch)) {
      throw new Error("Expected mutation link fetch handler to be a function");
    }

    const okResponse = await batchFetch("/api/trpc", { method: "POST" });
    expect(okResponse).toBeInstanceOf(Response);
    expect(readObjectProperty(window.location, "href")).toBe("/dashboard");

    await batchFetch("/api/trpc", { method: "POST" });
    expect(readObjectProperty(window.location, "href")).toBe("/login");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/trpc",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/trpc",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("query link fetch uses credentials and redirects only on 401", async () => {
    const fetchMock = vi
      .fn<(requestUrl: RequestInfo | URL, requestOptions?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { href: "/dashboard" } });

    const { createTRPCClient } = await import("./trpc.ts");
    createTRPCClient();

    const streamLinkOptions = httpBatchStreamLinkMock.mock.calls[0]?.[0];
    const streamFetch = readObjectProperty(streamLinkOptions, "fetch");
    if (!isFunction(streamFetch)) {
      throw new Error("Expected query link fetch handler to be a function");
    }

    const okResponse = await streamFetch("/api/trpc", { method: "POST" });
    expect(okResponse).toBeInstanceOf(Response);
    expect(readObjectProperty(window.location, "href")).toBe("/dashboard");

    await streamFetch("/api/trpc", { method: "POST" });
    expect(readObjectProperty(window.location, "href")).toBe("/login");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/trpc",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/trpc",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
