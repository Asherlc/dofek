import { describe, expect, it, vi } from "vitest";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000101";
const startedAt = "2026-06-15T00:30:00.000Z";

function makeRepository(ftp: number | null, np: number | null, hasNpRow = true) {
  const execute = vi.fn().mockResolvedValue([
    {
      requested_id: activityId,
      activity_id: activityId,
      started_at: startedAt,
      ended_at: "2026-06-15T01:30:00.000Z",
      activity_date: "2026-06-15",
      canonical_type: "cycling",
      ftp,
      threshold_effective_from: "2026-06-15",
      threshold_source_record_id: "00000000-0000-4000-8000-000000000201",
    },
  ]);
  const query = vi
    .fn()
    .mockResolvedValue(
      hasNpRow ? [{ activity_id: activityId, normalized_power: np, power_sample_count: 3600 }] : [],
    );
  return {
    repository: new CyclingThresholdRepository(
      { execute },
      { query },
      userId,
      "America/Los_Angeles",
    ),
    execute,
    query,
  };
}

describe("CyclingThresholdRepository", () => {
  it.each([
    { ftp: 250, intensityFactor: 1, powerTss: 100 },
    { ftp: 200, intensityFactor: 1.25, powerTss: 156.25 },
  ])(
    "computes manual FTP stress using elapsed duration: $ftp W",
    async ({ ftp, intensityFactor, powerTss }) => {
      const { repository, execute, query } = makeRepository(ftp, 250);

      const metrics = await repository.getForActivities([activityId]);

      expect(metrics.get(activityId)).toMatchObject({
        activity_date: "2026-06-15",
        normalized_power: 250,
        ftp,
        intensity_factor: intensityFactor,
        power_tss: powerTss,
        threshold: {
          value: ftp,
          effective_from: "2026-06-15",
          kind: "configured",
        },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the FTP for zones when the NP projection is unavailable", async () => {
    const { repository } = makeRepository(250, null, false);
    const metrics = (await repository.getForActivities([activityId])).get(activityId);
    expect(metrics).toMatchObject({
      ftp: 250,
      normalized_power: null,
      power_sample_count: null,
      intensity_factor: null,
      power_tss: null,
    });
  });

  it("keeps a recorded zero-power observation distinct from a missing NP row", async () => {
    const { repository } = makeRepository(250, 0, true);
    const metrics = (await repository.getForActivities([activityId])).get(activityId);
    expect(metrics).toMatchObject({
      ftp: 250,
      normalized_power: 0,
      power_sample_count: 3600,
      intensity_factor: 0,
      power_tss: 0,
    });
  });

  it("preserves a dated clear without falling back to an older FTP", async () => {
    const { repository } = makeRepository(null, 250);
    const metrics = (await repository.getForActivities([activityId])).get(activityId);
    expect(metrics).toMatchObject({
      ftp: null,
      intensity_factor: null,
      power_tss: null,
      threshold: {
        value: null,
        effective_from: "2026-06-15",
      },
    });
  });

  it("does not apply cycling FTP to other sport types", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        requested_id: activityId,
        activity_id: activityId,
        started_at: startedAt,
        ended_at: "2026-06-15T01:30:00.000Z",
        activity_date: "2026-06-15",
        canonical_type: "running",
        ftp: 250,
        threshold_effective_from: "2026-06-15",
        threshold_source_record_id: "00000000-0000-4000-8000-000000000201",
      },
    ]);
    const query = vi
      .fn()
      .mockResolvedValue([
        { activity_id: activityId, normalized_power: 250, power_sample_count: 3600 },
      ]);
    const repository = new CyclingThresholdRepository({ execute }, { query }, userId, "UTC");
    expect((await repository.getForActivities([activityId])).get(activityId)).toMatchObject({
      ftp: null,
      intensity_factor: null,
      power_tss: null,
    });
  });
});
