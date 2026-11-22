import type { CyclingPowerProfile } from "./cycling-power-profile.ts";

const weight = {
  value_kg: 72,
  kind: "measured",
  method: "same_day",
  quality: "high",
  distance_days: 0,
  sources: [
    {
      date: "2026-10-31",
      recorded_at: "2026-10-31T08:00:00.000Z",
      value_kg: 72,
      provider: "withings",
      source_record_id: null,
      record_id: "00000000-0000-4000-8000-000000000020",
      measurement_kind: "direct",
    },
  ],
} as const;

const rideId = "00000000-0000-4000-8000-000000000010";

export const cyclingPowerProfileWeightRecordFixture = {
  id: weight.sources[0].record_id,
  provider_id: weight.sources[0].provider,
  recorded_at: weight.sources[0].recorded_at,
  weight_kg: weight.value_kg,
};

export const cyclingPowerProfileFixture: CyclingPowerProfile = {
  range: { start_date: "2026-10-01", end_date: "2026-10-31", timezone: "America/Los_Angeles" },
  maximal_test_status: "unverified",
  efforts: [
    { duration_seconds: 5, effort: null },
    { duration_seconds: 60, effort: null },
    {
      duration_seconds: 300,
      effort: {
        duration_seconds: 300,
        watts: 336,
        watts_per_kg: 4.667,
        watts_per_kg_reason: null,
        weight: { ...weight, sources: [...weight.sources] },
        activity_id: rideId,
        activity_name: "Hill repeats",
        date: "2026-10-31",
        started_at: "2026-10-31T15:00:00.000Z",
        start_offset_seconds: 2480,
        end_offset_seconds: 2780,
        canonical_type: "cycling",
        modality: "virtual",
        power_kind: "unknown",
        source_providers: ["strava"],
        source_devices: [],
        member_activity_ids: [rideId],
        quality: {
          status: "limited",
          reasons: ["Power measurement method is unknown"],
          observed_samples: 301,
          coverage_pct: 100,
          continuity_tolerance_seconds: 5,
          median_sample_interval_seconds: 1,
          largest_gap_seconds: 1,
        },
      },
    },
  ],
  threshold: {
    watts: 288,
    watts_per_kg: 4,
    effective_from: "2026-10-12",
    source_record_id: "00000000-0000-4000-8000-000000000030",
    method: "configured",
    unavailable_reason: null,
    weight: { ...weight, sources: [...weight.sources] },
  },
};
