import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cyclingTrainingMetricsOutputSchema,
  cyclingTrainingMetricsToolOutputSchema,
  lambertsTestResultSchema,
} from "./cycling-training-metrics-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn(), lambertsListRange: vi.fn() }));

vi.mock("../repositories/cycling-training-metrics-repository.ts", () => ({
  CyclingTrainingMetricsRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.listRange };
  }),
}));

vi.mock("../repositories/lamberts-test-repository.ts", () => ({
  LambertsTestRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.lambertsListRange };
  }),
}));

import { registerCyclingTrainingMetricsTool } from "./cycling-training-metrics-tool.ts";

const activityId = "00000000-0000-4000-8000-000000000010";

function page() {
  const emptyCoverage = {
    observed_samples: 0,
    covered_seconds: 0,
    missing_seconds: 3600,
    zero_seconds: 0,
    coverage_pct: 0,
    median_sample_interval_seconds: null,
    largest_gap_seconds: null,
  };
  return {
    range: { start_date: "2026-06-01", end_date: "2026-06-30", timezone: "UTC" },
    requested_best_power_durations_seconds: [300, 1200],
    definitions: {
      normalized_power: "NP formula",
      variability_index: "VI formula",
      intensity_factor: "IF formula",
      training_stress_score: "TSS formula",
      work_kilojoules: "Work formula",
      aerobic_efficiency: "Efficiency formula",
      cardiac_drift: "Drift formula",
      interval_detection: "Interval rule",
    },
    activities: [
      {
        activity_id: activityId,
        date: "2026-06-15",
        started_at: "2026-06-15T15:00:00.000Z",
        ended_at: "2026-06-15T16:00:00.000Z",
        duration_seconds: 3600,
        name: "Ride",
        modality: "indoor",
        provider_id: "peloton",
        source_providers: ["peloton"],
        source_devices: ["Peloton Bike"],
        member_activity_ids: [activityId],
        thresholds: {
          ftp: {
            value: 250,
            unit: "watt",
            effective_from: "2026-06-15",
            source_record_id: "00000000-0000-4000-8000-000000000011",
            kind: "configured",
          },
          threshold_heart_rate: null,
        },
        metrics: {
          value_kind: "calculated_from_samples" as const,
          power: {
            average_watts: 200,
            normalized_watts: 205,
            variability_index: 1.025,
            work_kilojoules: 720,
            intensity_factor: 0.82,
            training_stress_score: 67.2,
          },
          heart_rate: { average_bpm: 140, maximum_bpm: 155 },
          cadence: { average_rpm: 90 },
          aerobic_efficiency: { power_to_heart_rate_ratio: 1.429, paired_seconds: 3600 },
          cardiac_drift: {
            percent: 3.2,
            first_half_power_to_heart_rate: 1.45,
            second_half_power_to_heart_rate: 1.404,
            paired_seconds: 3600,
            method: "equal_elapsed_time_halves_power_to_heart_rate",
          },
          power_zones: {
            threshold: 250,
            upper_pcts: [0.55, 0.75, 0.9],
            zones: [
              { zone: 1, seconds: 0, percent: 0 },
              { zone: 2, seconds: 0, percent: 0 },
              { zone: 3, seconds: 3600, percent: 100 },
              { zone: 4, seconds: 0, percent: 0 },
            ],
          },
          heart_rate_zones: null,
          coverage: {
            power: {
              ...emptyCoverage,
              observed_samples: 3600,
              covered_seconds: 3600,
              missing_seconds: 0,
              coverage_pct: 100,
              median_sample_interval_seconds: 1,
              largest_gap_seconds: 1,
            },
            heart_rate: {
              ...emptyCoverage,
              observed_samples: 3600,
              covered_seconds: 3600,
              missing_seconds: 0,
              coverage_pct: 100,
              median_sample_interval_seconds: 1,
              largest_gap_seconds: 1,
            },
            cadence: {
              ...emptyCoverage,
              observed_samples: 3600,
              covered_seconds: 3600,
              missing_seconds: 0,
              coverage_pct: 100,
              median_sample_interval_seconds: 1,
              largest_gap_seconds: 1,
            },
          },
          interval_source: "recorded" as const,
          interval_detection: null,
          intervals: [
            {
              index: 1,
              type: "work" as const,
              label: "Threshold",
              source: "recorded" as const,
              source_kind: "provider_recorded" as const,
              source_provider: "peloton",
              source_activity_id: activityId,
              segment_type: "power_zone",
              start_offset_seconds: 600,
              end_offset_seconds: 1200,
              duration_seconds: 600,
              average_power_watts: 240,
              normalized_power_watts: 245,
              average_heart_rate_bpm: 155,
              average_cadence_rpm: 95,
              target_intensity: 0.96,
              target_zone: 4,
              target_cadence_rpm: 95,
              target_power_watts: 240,
              target_resistance: 38,
              work_recovery_kind: "work" as const,
              completion_pct: 100,
              source_member_activity_ids: [activityId],
              raw: { source: "fixture" },
            },
          ],
          unavailable_reasons: [],
        },
        best_powers: [
          {
            duration_seconds: 300,
            watts: 220,
            start_offset_seconds: 60,
            power_kind: "direct" as const,
            quality: {
              status: "high" as const,
              reasons: [],
              observed_samples: 301,
              coverage_pct: 100,
              median_sample_interval_seconds: 1,
              largest_gap_seconds: 1,
            },
          },
        ],
        provider_aggregates: {
          average_power_watts: 200,
          average_heart_rate_bpm: 140,
          maximum_heart_rate_bpm: 155,
          kind: "calculated_read_model" as const,
        },
        provenance: {
          duplicate_merged: false,
          sample_source_providers: ["peloton"],
          power_measurement_kinds: ["direct"],
          activity_timezone: "America/New_York",
          timezone_source: "provider_timezone",
          timezone_assumption_required: false,
        },
        quality: {
          status: "high" as const,
          trustworthy_for_longitudinal_comparison: true,
          reasons: [],
        },
      },
    ],
    next_cursor: null,
  };
}

function lambertsPage() {
  const stage = (stage: 1 | 2 | 3, target: 60 | 80 | 90, watts: number) => ({
    stage,
    target_maximum_heart_rate_pct: target,
    mean_power_watts: watts,
    mean_heart_rate_bpm: 150 + stage * 5,
    mean_cadence_rpm: 90,
    mean_speed_meters_per_second: 8,
    perceived_exertion: null,
  });
  const test = (day: number, watts: number) => ({
    activity_id: `00000000-0000-4000-8000-0000000000${String(day).padStart(2, "0")}` as const,
    source_activity_id:
      `00000000-0000-4000-8000-0000000001${String(day).padStart(2, "0")}` as const,
    source_provider: "wahoo",
    source_name: "FIT File",
    date: `2026-11-${String(day).padStart(2, "0")}`,
    started_at: `2026-11-${String(day).padStart(2, "0")}T15:00:00.000Z`,
    modality: "indoor",
    source_providers: ["wahoo", "strava"],
    source_devices: ["kickr"],
    sample_source_providers: ["wahoo"],
    power_measurement_kinds: ["direct" as const],
    heart_rate_maximum: { configured_bpm: 190, measurement_method: "unknown" as const },
    stages: [stage(1, 60, 120), stage(2, 80, watts), stage(3, 90, watts + 60)],
    recovery: {
      observed_heart_rate_drop_bpm: 44,
      non_pedaling: true,
      seated_upright: null,
    },
  });
  const earliest = test(7, 222);
  const latest = test(21, 230);
  return {
    protocol: "lamberts_submaximal_cycle_test" as const,
    range: { start_date: "2026-11-01", end_date: "2026-11-21", timezone: "UTC" },
    total_tests: 3,
    tests: [latest, test(14, 225)],
    next_cursor: "next-lamberts-page",
    comparison: {
      earliest: {
        activity_id: earliest.activity_id,
        date: earliest.date,
        started_at: earliest.started_at,
        stage_2_mean_power_watts: 222,
        stage_3_mean_power_watts: 282,
      },
      latest: {
        activity_id: latest.activity_id,
        date: latest.date,
        started_at: latest.started_at,
        stage_2_mean_power_watts: 230,
        stage_3_mean_power_watts: 290,
      },
      stage_2_mean_watts_change: 8,
      stage_3_mean_watts_change: 8,
    },
  };
}

describe("get_cycling_training_metrics", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue(page());
    mocks.lambertsListRange.mockReset().mockResolvedValue(lambertsPage());
    server = new McpServer({ name: "cycling-training-metrics-test", version: "1.0.0" });
    registerCyclingTrainingMetricsTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    client = new Client({ name: "cycling-training-metrics-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("uses compact defaults and returns strictly parsed workout evidence", async () => {
    const result = await client.callTool({
      name: "get_cycling_training_metrics",
      arguments: { start_date: "2026-06-01", end_date: "2026-06-30" },
    });

    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [
        1, 5, 15, 30, 60, 120, 180, 300, 420, 600, 720, 1200, 1800, 2400, 3600, 5400, 7200,
      ],
      cursor: null,
      limit: 10,
    });
    const parsed = cyclingTrainingMetricsOutputSchema.parse(result.structuredContent);
    expect(parsed.result.activities[0]).toMatchObject({
      activity_id: activityId,
      metrics: { power: { normalized_watts: 205, training_stress_score: 67.2 } },
      quality: { trustworthy_for_longitudinal_comparison: true },
    });
    expect(
      cyclingTrainingMetricsOutputSchema.safeParse({
        ...result.structuredContent,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("constrains interval type only when work/recovery evidence exists", () => {
    const result = page();
    const activity = result.activities[0];
    const interval = activity?.metrics.intervals[0];
    if (!activity || !interval) throw new Error("Expected the cycling interval fixture");

    expect(
      cyclingTrainingMetricsOutputSchema.safeParse({
        result: {
          ...result,
          activities: [
            {
              ...activity,
              metrics: {
                ...activity.metrics,
                intervals: [{ ...interval, type: "recovery" as const }],
              },
            },
          ],
        },
      }).success,
    ).toBe(false);

    expect(
      cyclingTrainingMetricsOutputSchema.safeParse({
        result: {
          ...result,
          activities: [
            {
              ...activity,
              metrics: {
                ...activity.metrics,
                intervals: [
                  {
                    ...interval,
                    type: "cooldown" as const,
                    source_kind: "unknown" as const,
                    work_recovery_kind: null,
                  },
                ],
              },
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("passes date, activity, provider, duration, and cursor filters", async () => {
    await client.callTool({
      name: "get_cycling_training_metrics",
      arguments: {
        start_date: "2026-06-01",
        end_date: "2026-06-30",
        modalities: ["outdoor"],
        providers: ["wahoo"],
        best_power_durations_seconds: [300, 1200],
        cursor: "next-page",
        limit: 20,
      },
    });

    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: ["outdoor"],
      providers: ["wahoo"],
      durationsSeconds: [300, 1200],
      cursor: "next-page",
      limit: 20,
    });
  });

  it("rejects a reversed date range", async () => {
    await expect(
      client.callTool({
        name: "get_cycling_training_metrics",
        arguments: { start_date: "2026-07-01", end_date: "2026-06-30" },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("uses the Lamberts repository and strict alternate output when the opt-in is set", async () => {
    const result = await client.callTool({
      name: "get_cycling_training_metrics",
      arguments: {
        start_date: "2026-11-01",
        end_date: "2026-11-21",
        test_protocol: "lamberts_submaximal_cycle_test",
        modalities: ["indoor"],
        providers: ["wahoo"],
        cursor: "page-two",
        limit: 2,
      },
    });

    expect(mocks.listRange).not.toHaveBeenCalled();
    expect(mocks.lambertsListRange).toHaveBeenCalledWith({
      startDate: "2026-11-01",
      endDate: "2026-11-21",
      modalities: ["indoor"],
      providers: ["wahoo"],
      cursor: "page-two",
      limit: 2,
    });
    const parsed = lambertsTestResultSchema.parse(
      cyclingTrainingMetricsToolOutputSchema.parse(result.structuredContent).result,
    );
    expect(parsed.protocol).toBe("lamberts_submaximal_cycle_test");
    expect(parsed.total_tests).toBe(3);
    expect(parsed.tests).toHaveLength(2);
    expect(parsed.tests[0]).toMatchObject({
      activity_id: "00000000-0000-4000-8000-000000000021",
      heart_rate_maximum: { configured_bpm: 190, measurement_method: "unknown" },
      stages: [
        expect.objectContaining({ stage: 1, target_maximum_heart_rate_pct: 60 }),
        expect.objectContaining({ stage: 2, target_maximum_heart_rate_pct: 80 }),
        expect.objectContaining({ stage: 3, target_maximum_heart_rate_pct: 90 }),
      ],
    });
    expect(parsed.next_cursor).toBe("next-lamberts-page");
    expect(parsed.comparison).toMatchObject({
      stage_2_mean_watts_change: 8,
      stage_3_mean_watts_change: 8,
    });
  });

  it("keeps the legacy repository and wire shape when the opt-in is absent", async () => {
    const result = await client.callTool({
      name: "get_cycling_training_metrics",
      arguments: { start_date: "2026-06-01", end_date: "2026-06-30" },
    });
    expect(mocks.lambertsListRange).not.toHaveBeenCalled();
    expect(
      cyclingTrainingMetricsOutputSchema.parse(result.structuredContent).result.activities,
    ).toHaveLength(1);
  });

  it("rejects an unknown test protocol", async () => {
    await expect(
      client.callTool({
        name: "get_cycling_training_metrics",
        arguments: {
          start_date: "2026-06-01",
          end_date: "2026-06-30",
          test_protocol: "some_other_test",
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(mocks.lambertsListRange).not.toHaveBeenCalled();
  });

  it("shares date validation with the Lamberts mode", async () => {
    await expect(
      client.callTool({
        name: "get_cycling_training_metrics",
        arguments: {
          start_date: "2026-07-01",
          end_date: "2026-06-30",
          test_protocol: "lamberts_submaximal_cycle_test",
        },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(mocks.lambertsListRange).not.toHaveBeenCalled();
  });

  it("rejects an unknown protocol field in the Lamberts wire shape", () => {
    const result = lambertsPage();
    expect(lambertsTestResultSchema.safeParse({ ...result, protocol: "other" }).success).toBe(
      false,
    );
  });

  it.each([
    {
      label: "missing activity scope",
      scopes: [] as const,
      sensorStore: { query: vi.fn() },
    },
    {
      label: "missing analytics store",
      scopes: ["activity:read"] as const,
      sensorStore: undefined,
    },
  ])("rejects $label", async ({ scopes, sensorStore }) => {
    const isolatedServer = new McpServer({ name: "isolated-test", version: "1.0.0" });
    registerCyclingTrainingMetricsTool(isolatedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: [...scopes],
      timezone: "UTC",
      ...(sensorStore ? { sensorStore } : {}),
    });
    const isolatedClient = new Client({ name: "isolated-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await isolatedServer.connect(serverTransport);
    await isolatedClient.connect(clientTransport);
    try {
      await expect(
        isolatedClient.callTool({
          name: "get_cycling_training_metrics",
          arguments: { start_date: "2026-06-01", end_date: "2026-06-30" },
        }),
      ).resolves.toMatchObject({ isError: true });
    } finally {
      await isolatedClient.close();
      await isolatedServer.close();
    }
  });
});
