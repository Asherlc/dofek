import { beforeEach, describe, expect, it, vi } from "vitest";
import { identifyUser, resetUser } from "./telemetry";
import { createTrpcFetch } from "./trpc-fetch";

const mockCaptureException = vi.hoisted(() => vi.fn());
const mockLogInfo = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./telemetry")>()),
  captureException: mockCaptureException,
  logger: { info: mockLogInfo },
}));

describe("createTrpcFetch", () => {
  beforeEach(() => {
    resetUser();
    mockCaptureException.mockClear();
    mockLogInfo.mockClear();
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
    const previewError = new Error("clone failed");
    vi.spyOn(response, "clone").mockImplementation(() => {
      throw previewError;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(
      trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData"),
    ).rejects.toThrow(
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413 Payload Too Large, content-type text/plain, body preview unavailable",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(previewError, {
      source: "trpc-response-body-preview",
    });
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
    expect(mockCaptureException).toHaveBeenCalledWith(thrownError, {});
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

  it("records actual HTTP status with upload correlation before response diagnostics", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("payload too large", {
        status: 413,
        headers: { "content-type": "text/plain" },
      }),
    );
    const trpcFetch = createTrpcFetch(fetchImpl);

    await expect(
      trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData", {
        headers: { "x-dofek-upload-id": "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toThrow("413");

    expect(mockLogInfo).toHaveBeenCalledWith(
      "whoop-ble",
      "upload_http_response",
      expect.objectContaining({
        event: "upload_http_response",
        batchId: "11111111-1111-4111-8111-111111111111",
        httpStatus: 413,
        elapsedMs: expect.any(Number),
      }),
    );
  });

  it.each(["different-account", "logged-out", "same-account-new-session"])(
    "retires pending upload response telemetry after the session changes (%s)",
    async (transition) => {
      identifyUser({ id: "first-account", name: "First User", email: null });
      let resolveResponse: ((response: Response) => void) | undefined;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const trpcFetch = createTrpcFetch(fetchImpl);
      const request = trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData", {
        headers: { "x-dofek-upload-id": "11111111-1111-4111-8111-111111111111" },
      });

      if (transition === "different-account") {
        identifyUser({ id: "second-account", name: "Current User", email: null });
      } else {
        resetUser();
        if (transition === "same-account-new-session") {
          identifyUser({ id: "first-account", name: "Current User", email: null });
        }
      }
      const response = new Response('{"result":{"data":{"inserted":1}}}', {
        headers: { "content-type": "application/json" },
      });
      if (!resolveResponse) throw new Error("HTTP request did not start.");
      resolveResponse(response);

      await expect(request).resolves.toBe(response);
      expect(mockLogInfo).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({ result: { data: { inserted: 1 } } });
    },
  );

  it("preserves a retired request's malformed JSON error without reporting it under the next account", async () => {
    identifyUser({ id: "first-account", name: "First User", email: null });
    const response = new Response("{", { headers: { "content-type": "application/json" } });
    const trpcFetch = createTrpcFetch(vi.fn<typeof fetch>().mockResolvedValue(response));
    const result = await trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData");
    identifyUser({ id: "second-account", name: "Second User", email: null });

    await expect(result.json()).rejects.toThrow(
      "The server returned an invalid response for whoopBleSync.pushRealtimeData: 200, content-type application/json",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { retiredLifetime: true });
  });

  it("checks the captured session after a pending JSON body read finishes", async () => {
    identifyUser({ id: "first-account", name: "First User", email: null });
    const response = new Response("{", { headers: { "content-type": "application/json" } });
    let resolveBody: ((body: string) => void) | undefined;
    vi.spyOn(response, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
    );
    const trpcFetch = createTrpcFetch(vi.fn<typeof fetch>().mockResolvedValue(response));
    const result = await trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData");
    const body = result.json();
    identifyUser({ id: "second-account", name: "Second User", email: null });
    if (!resolveBody) throw new Error("JSON body read did not start.");
    resolveBody("{");

    await expect(body).rejects.toThrow("The server returned an invalid response");
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), { retiredLifetime: true });
  });

  it("preserves retired non-JSON response diagnostics when a pending preview read fails", async () => {
    identifyUser({ id: "first-account", name: "First User", email: null });
    const response = new Response("payload too large", {
      status: 413,
      headers: { "content-type": "text/plain" },
    });
    const preview = response.clone();
    vi.spyOn(response, "clone").mockReturnValue(preview);
    let rejectPreview: ((error: Error) => void) | undefined;
    vi.spyOn(preview, "text").mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectPreview = reject;
        }),
    );
    const trpcFetch = createTrpcFetch(vi.fn<typeof fetch>().mockResolvedValue(response));
    const request = trpcFetch("https://dofek.test/api/trpc/whoopBleSync.pushRealtimeData");
    await Promise.resolve();
    if (!rejectPreview) throw new Error("Preview read did not start.");
    identifyUser({ id: "second-account", name: "Second User", email: null });
    rejectPreview(new Error("Retired response preview failed"));

    await expect(request).rejects.toThrow(
      "Non-JSON tRPC response from whoopBleSync.pushRealtimeData: 413, content-type text/plain, body preview unavailable",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(
      new Error("Retired response preview failed"),
      { source: "trpc-response-body-preview", retiredLifetime: true },
    );
  });
});
