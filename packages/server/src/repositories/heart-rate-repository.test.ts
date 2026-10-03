import { describe, expect, it, vi } from "vitest";
import { HeartRateRepository } from "./heart-rate-repository.ts";

describe("HeartRateRepository", () => {
  it("groups per-minute samples by provider", async () => {
    const query = vi.fn(async () => [
      {
        provider_id: "whoop_ble",
        recorded_at: "2026-04-12T10:00:00Z",
        heart_rate: 72,
        sample_count: 2,
        min_heart_rate: 72,
        avg_heart_rate: 73,
        max_heart_rate: 74,
      },
      {
        provider_id: "whoop_ble",
        recorded_at: "2026-04-12T10:01:00Z",
        heart_rate: 74,
        sample_count: 2,
        min_heart_rate: 72,
        avg_heart_rate: 73,
        max_heart_rate: 74,
      },
      {
        provider_id: "apple_health",
        recorded_at: "2026-04-12T10:00:00Z",
        heart_rate: 70,
        sample_count: 1,
        min_heart_rate: 70,
        avg_heart_rate: 70,
        max_heart_rate: 70,
      },
    ]);

    const repo = new HeartRateRepository({ query }, "user-1", "UTC");
    const result = await repo.dailyBySource("2026-04-12");

    expect(result).toHaveLength(2);
    const ble = result.find((series) => series.providerId === "whoop_ble");
    expect(ble?.samples).toEqual([
      { time: "2026-04-12T10:00:00Z", heartRate: 72 },
      { time: "2026-04-12T10:01:00Z", heartRate: 74 },
    ]);
    expect(result.find((series) => series.providerId === "apple_health")?.samples).toHaveLength(1);
    expect(ble).toEqual(
      expect.objectContaining({
        sampleCount: 2,
        minHeartRate: 72,
        avgHeartRate: 73,
        maxHeartRate: 74,
      }),
    );
    expect(result.find((series) => series.providerId === "apple_health")).toEqual(
      expect.objectContaining({
        sampleCount: 1,
        minHeartRate: 70,
        avgHeartRate: 70,
        maxHeartRate: 70,
      }),
    );
  });

  it("passes the user id, timezone, and date through to the query", async () => {
    const query = vi.fn(async () => []);
    const repo = new HeartRateRepository({ query }, "user-9", "America/Los_Angeles");

    await repo.dailyBySource("2026-04-12");

    expect(query).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      userId: "user-9",
      timezone: "America/Los_Angeles",
      date: "2026-04-12",
    });
  });

  it("returns an empty array when there are no rows", async () => {
    const query = vi.fn(async () => []);
    const repo = new HeartRateRepository({ query }, "user-1", "UTC");
    expect(await repo.dailyBySource("2026-04-12")).toEqual([]);
  });
});
