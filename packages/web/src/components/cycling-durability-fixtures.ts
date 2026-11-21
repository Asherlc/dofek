import type { CyclingDurabilityEffort, CyclingDurabilityResult } from "dofek-server/types";

const baseline: CyclingDurabilityEffort = {
  activityId: "hill-repeats",
  activityName: "Hill repeats",
  date: "2026-11-03",
  startedAt: "2026-11-03T15:00:00Z",
  elapsedStartSeconds: 1122,
  elapsedEndSeconds: 1422,
  watts: 320,
  wattsPerKg: 4.444444444,
  workKilojoules: 190,
  workKilojoulesPerKg: 2.638888889,
  power: {
    deviceId: null,
    measurementKind: "direct",
    sourceExternalId: null,
    provenance: "direct",
    provider: "Strava",
    sourceMemberId: "hill-repeats",
  },
  coverage: {
    percent: 100,
    observedSamples: 300,
    largestGapSeconds: 1,
    medianSampleIntervalSeconds: 1,
  },
  weight: {
    value_kg: 72,
    kind: "measured",
    method: "same_day",
    quality: "high",
    distance_days: 0,
    sources: [
      {
        date: "2026-11-03",
        recorded_at: "2026-11-03T13:00:00Z",
        value_kg: 72,
        provider: "Withings",
        measurement_kind: "direct",
        source_record_id: null,
      },
    ],
  },
};

const afterWork: CyclingDurabilityEffort = {
  ...baseline,
  activityId: "saturday-endurance",
  activityName: "Saturday endurance ride",
  date: "2026-11-07",
  startedAt: "2026-11-07T15:00:00Z",
  elapsedStartSeconds: 12136,
  elapsedEndSeconds: 12436,
  watts: 296,
  wattsPerKg: 4.111111111,
  workKilojoules: 2246,
  workKilojoulesPerKg: 31.194444444,
  power: { ...baseline.power, sourceMemberId: "saturday-endurance" },
  weight: {
    ...baseline.weight,
    kind: "nearest",
    method: "nearest_within_30_days",
    quality: "low",
    distance_days: 4,
  },
};

export const cyclingDurabilityExample: CyclingDurabilityResult = {
  status: "available",
  range: { startDate: "2026-10-19", endDate: "2026-11-15" },
  selection: { durationSeconds: 300, minimumWorkKilojoulesPerKg: 30 },
  presentation: { unit: "watts", difference: 24, absoluteWorkCutoffKilojoules: 2160 },
  baseline,
  afterWork,
  sameEffort: false,
};

export const cyclingDurabilityDifferentWeights: CyclingDurabilityResult = {
  ...cyclingDurabilityExample,
  presentation: { unit: "w_per_kg", difference: 0.55, absoluteWorkCutoffKilojoules: null },
  afterWork: {
    ...afterWork,
    wattsPerKg: 3.894736842,
    workKilojoulesPerKg: 31.97368421,
    workKilojoules: 2430,
    weight: { ...afterWork.weight, value_kg: 76 },
  },
};

export const cyclingDurabilityNoLateEffort: CyclingDurabilityResult = {
  ...cyclingDurabilityExample,
  status: "no_effort_after_work",
  afterWork: null,
  presentation: { ...cyclingDurabilityExample.presentation, difference: 0 },
};
