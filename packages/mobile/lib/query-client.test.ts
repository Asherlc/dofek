import { environmentManager, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./query-client";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

beforeEach(() => {
  mockCaptureException.mockClear();
});

describe("createAppQueryClient", () => {
  it("does not automatically retry a failed query", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi.fn().mockRejectedValue(new Error("Server unavailable"));
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    const observer = new QueryObserver(queryClient, {
      queryKey: ["offline-query"],
      queryFn,
      retryDelay: 0,
    });
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = observer.subscribe((result) => {
        if (result.isError) {
          unsubscribe();
          resolve();
        }
      });
    });

    try {
      await settled;
    } finally {
      environmentManager.setIsServer(() => wasServer);
    }

    expect(queryFn).toHaveBeenCalledOnce();
  });

  it("reports handled query errors to Sentry", async () => {
    const queryClient = createAppQueryClient();
    const queryError = new Error("Unexpected end of JSON input");

    await expect(
      queryClient.fetchQuery({
        queryKey: [["processing", "status"], { type: "query" }],
        retry: false,
        queryFn: async () => {
          throw queryError;
        },
      }),
    ).rejects.toThrow(queryError);

    expect(mockCaptureException).toHaveBeenCalledWith(queryError, {
      source: "react-query",
      queryHash: '[["processing","status"],{"type":"query"}]',
      failureCount: 1,
    });
  });

  it.each([
    "fetch failed: UnexpectedException: The network connection was lost.",
    "fetch failed: UnexpectedException: The request timed out.",
    "Network request failed",
    "User canceled",
    "User cancelled",
    "fetch failed: canceled",
    "fetch failed: cancelled",
  ])("reports transient query error %j to Sentry", async (message) => {
    const queryClient = createAppQueryClient();
    const queryError = new Error(message);

    await expect(
      queryClient.fetchQuery({
        queryKey: ["offline-query", message],
        retry: false,
        queryFn: async () => {
          throw queryError;
        },
      }),
    ).rejects.toThrow(queryError);

    expect(mockCaptureException).toHaveBeenCalledWith(queryError, {
      source: "react-query",
      queryHash: `["offline-query","${message}"]`,
      failureCount: 1,
    });
  });
  it("reports a non-transient query error to Sentry", async () => {
    const queryClient = createAppQueryClient();
    const queryError = new Error("Unexpected end of JSON input");

    await expect(
      queryClient.fetchQuery({
        queryKey: ["unexpected-query"],
        retry: false,
        queryFn: async () => {
          throw queryError;
        },
      }),
    ).rejects.toThrow(queryError);

    expect(mockCaptureException).toHaveBeenCalledOnce();
  });
});
