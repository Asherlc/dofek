import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./query-client";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("createAppQueryClient", () => {
  it("reports handled query errors to Sentry", async () => {
    const queryClient = createAppQueryClient();
    const queryError = new Error("Unexpected end of JSON input");

    await expect(
      queryClient.fetchQuery({
        queryKey: [["sync", "dataHealth"], { type: "query" }],
        retry: false,
        queryFn: async () => {
          throw queryError;
        },
      }),
    ).rejects.toThrow(queryError);

    expect(mockCaptureException).toHaveBeenCalledWith(queryError, {
      source: "react-query",
      queryHash: '[["sync","dataHealth"],{"type":"query"}]',
      failureCount: 1,
    });
  });
});
