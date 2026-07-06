import { describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "./query-client.ts";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry.ts", () => ({
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

  it("configures default query options", () => {
    const queryClient = createAppQueryClient();
    const defaults = queryClient.getDefaultOptions();

    expect(defaults.queries).toMatchObject({
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    });
    expect(typeof defaults.queries?.gcTime).toBe("number");
  });
});
