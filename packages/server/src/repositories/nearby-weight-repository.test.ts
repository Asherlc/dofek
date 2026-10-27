import { describe, expect, it, vi } from "vitest";
import { NearbyWeightRepository } from "./nearby-weight-repository.ts";

describe("NearbyWeightRepository", () => {
  it("selects an end-date weight from canonical direct observations", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-07-30",
        recorded_at: "2026-07-30T08:00:00.000Z",
        weight_kg: 70,
        provider_id: "withings",
        external_id: "weight-1",
      },
      {
        date: "2026-08-03",
        recorded_at: "2026-08-03T08:00:00.000Z",
        weight_kg: 72,
        provider_id: "withings",
        external_id: "weight-2",
      },
    ]);

    const result = await new NearbyWeightRepository(
      { query },
      "00000000-0000-4000-8000-000000000001",
      "America/Los_Angeles",
    ).getForDate("2026-08-01");

    expect(result).toMatchObject({
      value_kg: 71,
      kind: "interpolated",
      method: "linear_interpolation",
      sources: [{ provider: "withings" }, { provider: "withings" }],
    });
    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("nearby-weight:observations"),
      {
        userId: "00000000-0000-4000-8000-000000000001",
        timezone: "America/Los_Angeles",
        startDate: "2026-08-01",
        endDate: "2026-08-01",
      },
    );
  });

  it("returns an explicit reason when no measured weight qualifies", async () => {
    const result = await new NearbyWeightRepository(
      { query: vi.fn().mockResolvedValue([]) },
      "00000000-0000-4000-8000-000000000001",
      "UTC",
    ).getForDate("2026-08-01");

    expect(result).toEqual({
      value_kg: null,
      reason: "No valid positive directly measured body weight is available",
    });
  });
});
