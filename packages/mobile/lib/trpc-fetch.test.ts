import { describe, expect, it, vi } from "vitest";
import { createTrpcFetch } from "./trpc-fetch";

describe("createTrpcFetch", () => {
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
