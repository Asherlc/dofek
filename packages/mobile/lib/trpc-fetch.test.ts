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
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413 Payload Too Large payload too large",
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
