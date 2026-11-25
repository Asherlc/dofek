import { beforeEach, describe, expect, it, vi } from "vitest";

const httpBatchStreamLinkMock = vi.fn((options: unknown) => ({
  type: "stream",
  options,
}));
const httpBatchLinkMock = vi.fn((options: unknown) => ({
  type: "batch",
  options,
}));
const httpLinkMock = vi.fn((options: unknown) => ({
  type: "http",
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
    httpLink: httpLinkMock,
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
    httpLinkMock.mockClear();
    splitLinkMock.mockClear();
    createClientMock.mockClear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("configures split link routing and shared link options", async () => {
    const { createTRPCClient } = await import("./trpc.ts");

    createTRPCClient();

    expect(httpBatchLinkMock).toHaveBeenCalledTimes(1);
    expect(httpLinkMock).toHaveBeenCalledTimes(1);
    expect(httpBatchStreamLinkMock).toHaveBeenCalledTimes(1);
    expect(splitLinkMock).toHaveBeenCalledTimes(2);
    expect(createClientMock).toHaveBeenCalledTimes(1);

    const mutationSplitOptions = splitLinkMock.mock.calls[1]?.[0];
    const querySplitOptions = splitLinkMock.mock.calls[0]?.[0];
    expect(mutationSplitOptions).toMatchObject({
      true: { type: "batch" },
      false: { type: "split" },
    });
    expect(querySplitOptions).toMatchObject({
      true: { type: "http" },
      false: { type: "stream" },
    });

    const mutationCondition = readObjectProperty(mutationSplitOptions, "condition");
    const queryCondition = readObjectProperty(querySplitOptions, "condition");
    expect(typeof mutationCondition).toBe("function");
    expect(typeof queryCondition).toBe("function");
    if (!isFunction(mutationCondition) || !isFunction(queryCondition)) {
      throw new Error("splitLink conditions must be functions");
    }
    expect(mutationCondition({ type: "mutation" })).toBe(true);
    expect(mutationCondition({ type: "query" })).toBe(false);
    expect(queryCondition({ type: "query", path: "recovery.workloadRatio" })).toBe(true);
    expect(queryCondition({ type: "mutation", path: "recovery.workloadRatio" })).toBe(false);
    expect(queryCondition({ type: "query", path: "processing.status" })).toBe(false);
    expect(queryCondition({ type: "query", path: "insights.compute" })).toBe(false);
    expect(queryCondition({ type: "query", path: "anomalyDetection.check" })).toBe(false);

    const batchLinkOptions = httpBatchLinkMock.mock.calls[0]?.[0];
    const httpLinkOptions = httpLinkMock.mock.calls[0]?.[0];
    const streamLinkOptions = httpBatchStreamLinkMock.mock.calls[0]?.[0];
    for (const linkOptions of [batchLinkOptions, httpLinkOptions, streamLinkOptions]) {
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

  it("reuses one credentials fetch across links, redirects only on 401, and guards raw 5xx", async () => {
    const fetchMock = vi
      .fn<(requestUrl: RequestInfo | URL, requestOptions?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: -32603, message: "INTERNAL_SERVER_ERROR" } }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { href: "/dashboard" } });

    const { createTRPCClient } = await import("./trpc.ts");
    createTRPCClient();

    const batchFetch = readObjectProperty(httpBatchLinkMock.mock.calls[0]?.[0], "fetch");
    const streamFetch = readObjectProperty(httpBatchStreamLinkMock.mock.calls[0]?.[0], "fetch");
    const httpFetch = readObjectProperty(httpLinkMock.mock.calls[0]?.[0], "fetch");
    if (!isFunction(batchFetch) || !isFunction(streamFetch) || !isFunction(httpFetch)) {
      throw new Error("Expected shared link fetch handlers to be functions");
    }
    expect(batchFetch).toBe(streamFetch);
    expect(batchFetch).toBe(httpFetch);

    const okResponse = await batchFetch("/api/trpc", { method: "POST" });
    expect(okResponse).toBeInstanceOf(Response);
    expect(readObjectProperty(window.location, "href")).toBe("/dashboard");

    await batchFetch("/api/trpc", { method: "POST" });
    expect(readObjectProperty(window.location, "href")).toBe("/login");

    const { HttpResponseError, classifyHandledFailure } = await import(
      "@dofek/telemetry/handled-failure"
    );
    let htmlFailure: unknown;
    try {
      await batchFetch("/api/trpc", { method: "POST" });
    } catch (error: unknown) {
      htmlFailure = error;
    }
    expect(htmlFailure).toBeInstanceOf(HttpResponseError);
    expect(classifyHandledFailure(htmlFailure)).toBe("http_5xx");

    const structured = await batchFetch("/api/trpc", { method: "POST" });
    if (!(structured instanceof Response)) {
      throw new Error("Expected structured tRPC 5xx fetch to return a Response");
    }
    await expect(structured.json()).resolves.toEqual({
      error: { code: -32603, message: "INTERNAL_SERVER_ERROR" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trpc",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });
});
