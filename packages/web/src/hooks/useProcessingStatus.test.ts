import { describe, expect, it, vi } from "vitest";

const { useQuery } = vi.hoisted(() => ({
  useQuery: vi.fn(
    (
      _input: unknown,
      options: {
        refetchInterval(query: {
          state: { data?: { overallStatus: "active" | "delayed" | "ready" } };
        }): number | false;
      },
    ) => options,
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: { processing: { status: { useQuery } } },
}));

import { useProcessingStatus } from "./useProcessingStatus.ts";

describe("useProcessingStatus", () => {
  it("uses the processing state to select an adaptive polling interval", () => {
    useProcessingStatus({ providerId: "garmin", datasets: ["activity"] });

    expect(useQuery).toHaveBeenCalledWith(
      { providerId: "garmin", datasets: ["activity"] },
      expect.objectContaining({ refetchInterval: expect.any(Function) }),
    );
    const options = useQuery.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    if (!options) {
      throw new Error("Expected the processing status query options");
    }
    expect(options.refetchInterval({ state: { data: { overallStatus: "active" } } })).toBe(3_000);
    expect(options.refetchInterval({ state: { data: { overallStatus: "delayed" } } })).toBe(15_000);
    expect(options.refetchInterval({ state: { data: { overallStatus: "ready" } } })).toBe(15_000);
    expect(options.refetchInterval({ state: {} })).toBe(15_000);
  });
});
