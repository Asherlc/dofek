import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cyclingTrainingMetricsOutputSchema } from "./cycling-training-metrics-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn() }));

vi.mock("../repositories/cycling-training-metrics-repository.ts", () => ({
  CyclingTrainingMetricsRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.listRange };
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
            unit: "W",
            effective_from: "2026-01-01",
            source_record_id: "00000000-0000-4000-8000-000000000100",
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
          interval_source: "none" as const,
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
          normalized_power_watts: 205,
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

describe("get_cycling_training_metrics", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue(page());
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
