/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProcessingAlerts } from "./useProcessingAlerts.ts";

const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    processing: {
      alerts: {
        useQuery: mockUseQuery,
      },
    },
  },
}));

describe("useProcessingAlerts", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
  });

  it("polls active alerts at the recoverable-status interval", () => {
    const query = { data: { generatedAt: "2026-07-25T00:00:00.000Z", alerts: [] } };
    mockUseQuery.mockReturnValue(query);

    expect(useProcessingAlerts()).toBe(query);
    expect(mockUseQuery).toHaveBeenCalledWith(undefined, { refetchInterval: 15_000 });
  });
});
