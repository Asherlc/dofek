import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTrpcFetch } from "./trpc-fetch";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("createTrpcFetch", () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

  it("throws an actionable error when tRPC receives a non-JSON response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("payload too large", {
        status: 413,
        statusText: "Payload Too Large",
        headers: { "content-type": "text/plain" },
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(
      trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData"),
    ).rejects.toThrow(
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413 Payload Too Large, content-type text/plain, payload too large",
    );
  });

  it("keeps the diagnostic error when the body preview cannot be read", async () => {
    const response = new Response("payload too large", {
      status: 413,
      statusText: "Payload Too Large",
      headers: { "content-type": "text/plain" },
    });
    vi.spyOn(response, "clone").mockImplementation(() => {
      throw new Error("clone failed");
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(
      trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData"),
    ).rejects.toThrow(
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413 Payload Too Large, content-type text/plain, body preview unavailable",
    );
  });

  it("handles relative tRPC URLs in diagnostic errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("payload too large", {
        status: 413,
        statusText: "Payload Too Large",
        headers: { "content-type": "text/plain" },
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(trpcFetch("/api/trpc/whoopBleSync.pushRealtimeData")).rejects.toThrow(
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413 Payload Too Large, content-type text/plain, payload too large",
    );
  });

  it("reports absent content type without using an empty string sentinel", async () => {
    const responseBody = new TextEncoder().encode("payload too large");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(responseBody, {
        status: 413,
        statusText: "Payload Too Large",
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(
      trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData"),
    ).rejects.toThrow(
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413 Payload Too Large, content-type absent, payload too large",
    );
  });

  it("throws an actionable error when tRPC receives an empty JSON response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204,
        statusText: "No Content",
        headers: { "content-type": "application/json" },
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    const response = await trpcFetch("https://dofek.test/api/trpc/processing.status");

    await expect(response.json()).rejects.toThrow(
      "The server returned an empty response for processing.status: 204 No Content, content-type application/json",
    );
  });

  it("classifies empty JSON bodies without content-length as empty responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("  ", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    const response = await trpcFetch("https://dofek.test/api/trpc/processing.status");

    await expect(response.json()).rejects.toThrow(
      "The server returned an empty response for processing.status: 200 OK, content-type application/json",
    );
  });

  it("replaces JSON parser errors with the tRPC path and response status", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    const response = await trpcFetch("https://dofek.test/api/trpc/processing.status");

    let thrownError: unknown;
    try {
      await response.json();
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    if (!(thrownError instanceof Error)) throw new Error("Expected an Error");
    expect(thrownError.message).toBe(
      "The server returned an invalid response for processing.status: 200 OK, content-type application/json",
    );
    expect(thrownError.cause).toBeInstanceOf(SyntaxError);
    expect(mockCaptureException).toHaveBeenCalledWith(thrownError);
  });

  it("passes JSON responses through unchanged", async () => {
    const response = new Response(JSON.stringify({ result: { data: { json: { inserted: 1 } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(
      trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData"),
    ).resolves.toBe(response);
  });
});
