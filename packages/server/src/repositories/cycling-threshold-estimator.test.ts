import { describe, expect, it, vi } from "vitest";
import {
  type CyclingThresholdEstimateInput,
  CyclingThresholdEstimator,
} from "./cycling-threshold-estimator.ts";

const activityId = "00000000-0000-4000-8000-000000000201";
const configured = {
  id: "00000000-0000-4000-8000-000000000101",
  evidence_kind: "configured" as const,
  sport: "cycling",
  threshold_type: "ftp",
  value: 245,
  unit: "watt",
  observed_at: "2026-05-28T16:00:00.000Z",
  effective_at: "2026-06-01T07:00:00.000Z",
  provider: null,
  provider_record_id: null,
  value_kind: "configured" as const,
  historical_validity: "effective_dated" as const,
  raw_evidence_available: false,
  quality: { status: "high" as const, reason: null },
};

function effort(duration: number, watts: number) {
  return {
    duration_seconds: duration,
    watts,
    watts_per_kg: null,
    watts_per_kg_reason: "not used by estimator",
    weight: { value_kg: null as const, reason: "not used by estimator" },
    activity_id: activityId,
    date: "2026-07-15",
    started_at: "2026-07-15T15:00:00.000Z",
    start_offset_seconds: 30,
    canonical_type: "cycling",
    power_kind: "direct" as const,
    source_providers: ["wahoo"],
    source_devices: ["elemnt-bolt"],
    member_activity_ids: [activityId],
    quality: {
      status: "high" as const,
      reasons: [],
      observed_samples: duration + 1,
      coverage_pct: 100,
      continuity_tolerance_seconds: 5,
      median_sample_interval_seconds: 1,
      largest_gap_seconds: 1,
    },
  };
}

function dependencies() {
  return {
    powerCurve: {
      listRange: vi.fn().mockResolvedValue({
        start_date: "2026-05-01",
        end_date: "2026-08-01",
        durations_seconds: [],
        bests: [],
        activity_curve: [],
        next_cursor: null,
      }),
    },
    thresholds: {
      getApplicableConfiguredFtp: vi.fn().mockResolvedValue(null),
      listHistory: vi.fn().mockResolvedValue({
        start_date: "2026-05-01",
        end_date: "2026-08-01",
        items: [],
        legacy_current: null,
        next_cursor: null,
      }),
    },
    nearbyWeight: {
      getForDate: vi.fn().mockResolvedValue({
        value_kg: 70,
        kind: "measured",
        method: "same_day",
        quality: "high",
        distance_days: 0,
        sources: [
          {
            date: "2026-08-01",
            recorded_at: "2026-08-01T08:00:00.000Z",
            value_kg: 70,
            provider: "withings",
            source_record_id: "weight-1",
            measurement_kind: "direct",
          },
        ],
      }),
    },
  };
}

const baseInput: Omit<CyclingThresholdEstimateInput, "method"> = {
  startDate: "2026-05-01",
  endDate: "2026-08-01",
  providers: [],
  modalities: [],
};

describe("CyclingThresholdEstimator", () => {
  it("returns effective-dated configuration first for best_supported", async () => {
    const deps = dependencies();
    deps.thresholds.getApplicableConfiguredFtp.mockResolvedValue(configured);

    const result = await new CyclingThresholdEstimator(deps).estimate({
      ...baseInput,
      method: "best_supported",
    });

    expect(result.result).toMatchObject({
      threshold_watts: 245,
      method: "recorded_provider",
      classification: "configured",
      confidence: "high",
      watts_per_kg: 3.5,
      evidence: { threshold_history: [configured], efforts: [] },
    });
    expect(deps.powerCurve.listRange).not.toHaveBeenCalled();
  });

  it("uses explicit provider FTP but never provider-modeled FTP for recorded_provider", async () => {
    const deps = dependencies();
    deps.thresholds.listHistory.mockResolvedValue({
      start_date: baseInput.startDate,
      end_date: baseInput.endDate,
      legacy_current: null,
      next_cursor: null,
      items: [
        {
          ...configured,
          id: "00000000-0000-4000-8000-000000000102",
          value: 258,
          threshold_type: "modeled_ftp",
          value_kind: "provider_estimated" as const,
          evidence_kind: "provider_observation" as const,
          provider: "zwift",
          provider_record_id: "power-profile:12345",
          historical_validity: "observed_from_date" as const,
        },
        {
          ...configured,
          id: "00000000-0000-4000-8000-000000000103",
          value: 250,
          threshold_type: "ftp",
          value_kind: "provider_recorded" as const,
          evidence_kind: "provider_observation" as const,
          provider: "zwift",
          provider_record_id: "profile:12345",
          historical_validity: "observed_from_date" as const,
          effective_at: null,
          quality: { status: "moderate" as const, reason: "No effective date" },
        },
      ],
    });

    const result = await new CyclingThresholdEstimator(deps).estimate({
      ...baseInput,
      method: "recorded_provider",
    });

    expect(result.result).toMatchObject({
      threshold_watts: 250,
      classification: "provider_recorded",
      confidence: "moderate",
    });
  });

  it("labels 95 percent of maximal 20-minute power as an estimate", async () => {
    const deps = dependencies();
    deps.powerCurve.listRange.mockResolvedValue({
      start_date: baseInput.startDate,
      end_date: baseInput.endDate,
      durations_seconds: [1200],
      bests: [effort(1200, 300)],
      activity_curve: [],
      next_cursor: null,
    });

    const result = await new CyclingThresholdEstimator(deps).estimate({
      ...baseInput,
      method: "twenty_minute_95_percent",
    });

    expect(result.result).toMatchObject({
      threshold_watts: 285,
      method: "twenty_minute_95_percent",
      classification: "estimated",
      confidence: "moderate",
      relevant_activity_ids: [activityId],
      evidence: { efforts: [expect.objectContaining({ duration_seconds: 1200, watts: 300 })] },
      uncertainty: { watts: null, kind: "not_quantifiable" },
    });
  });

  it("uses the best qualifying 40 to 70 minute sustained effort", async () => {
    const deps = dependencies();
    deps.powerCurve.listRange.mockResolvedValue({
      start_date: baseInput.startDate,
      end_date: baseInput.endDate,
      durations_seconds: [2400, 3000, 3600, 4200],
      bests: [effort(2400, 270), effort(3000, 260), effort(3600, 250)],
      activity_curve: [],
      next_cursor: null,
    });

    const result = await new CyclingThresholdEstimator(deps).estimate({
      ...baseInput,
      method: "sustained_40_to_70_minutes",
    });

    expect(result.result).toMatchObject({
      threshold_watts: 270,
      classification: "estimated",
      assumptions: expect.arrayContaining([expect.stringContaining("40–70-minute")]),
    });
  });

  it("returns critical-power fit diagnostics without calling CP measured FTP", async () => {
    const deps = dependencies();
    deps.powerCurve.listRange.mockResolvedValue({
      start_date: baseInput.startDate,
      end_date: baseInput.endDate,
      durations_seconds: [120, 180, 300, 420, 600],
      bests: [
        effort(120, 355),
        effort(180, 320),
        effort(300, 290),
        effort(420, 275),
        effort(600, 262),
      ],
      activity_curve: [],
      next_cursor: null,
    });

    const result = await new CyclingThresholdEstimator(deps).estimate({
      ...baseInput,
      method: "critical_power_model",
    });

    expect(result.result).toMatchObject({
      classification: "estimated",
      method: "critical_power_model",
      model: {
        cp_watts: expect.any(Number),
        w_prime_joules: expect.any(Number),
        r2: expect.any(Number),
        rmse_watts: expect.any(Number),
        residuals: expect.any(Array),
      },
    });
    expect(result.result?.assumptions.join(" ")).toContain("not measured FTP");
  });

  it("returns an explicit unavailable reason and missing-weight reason", async () => {
    const deps = dependencies();
    deps.nearbyWeight.getForDate.mockResolvedValue({ value_kg: null, reason: "No weight" });

    const result = await new CyclingThresholdEstimator(deps).estimate({
      ...baseInput,
      method: "twenty_minute_95_percent",
    });

    expect(result).toEqual({
      start_date: baseInput.startDate,
      end_date: baseInput.endDate,
      requested_method: "twenty_minute_95_percent",
      result: null,
      unavailable_reason: "No valid 20-minute cycling power effort exists in the requested range",
      weight: { value_kg: null, reason: "No weight" },
    });
  });
});
