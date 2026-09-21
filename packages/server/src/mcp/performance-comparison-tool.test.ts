import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ compare: vi.fn() }));

vi.mock("../repositories/performance-comparison-repository.ts", () => ({
  PerformanceComparisonRepository: vi.fn(function vitestConstructor() {
    return { compare: mocks.compare };
  }),
}));

import {
  registerPerformanceComparisonTool,
  toRepositoryEquivalence,
} from "./performance-comparison-tool.ts";

const ACTIVITY_ID = "00000000-0000-4000-8000-000000000010";

describe("compare_performances", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    mocks.compare.mockReset().mockResolvedValue({
      range: { start_date: "2026-06-01", end_date: "2026-07-31", timezone: "UTC" },
      equivalence: {
        identity: { kind: "activity_name", namespace: "cycling", value: "FTP Test" },
        strength: "caller_asserted",
        basis: "caller_asserted",
        method: "exact_normalized_activity_name",
        confidence: "user_asserted",
        key: { kind: "activity_name", canonical_type: "cycling", value: "FTP Test" },
        assumptions: ["The caller asserted that this exact normalized name is equivalent."],
      },
      baseline: { activity_id: ACTIVITY_ID, selection: "earliest_match_in_range" },
      definitions: {
        comparison: "Only explicit or strongly evidenced equivalent performances are returned.",
        moving_duration: "Provider-reported evidence only.",
        normalized_power: "NP formula.",
        power_to_heart_rate_ratio: "Average power divided by average heart rate.",
        deltas: "Candidate minus baseline.",
        strength_estimated_one_rep_max: "Epley: weight_kg × (1 + reps / 30).",
        causality: "Descriptive comparison only.",
      },
      coverage: {
        canonical_activities: 1,
        cycling_metrics_from_deduped_samples: 0,
        environment_metrics_from_deduped_samples: 0,
        activities_with_missing_duration: 0,
        timezone_assumed_activities: 0,
        performances_with_equivalence_evidence: 1,
        performances_with_moving_duration: 0,
      },
      performances: [
        {
          activity_id: ACTIVITY_ID,
          date: "2026-06-01",
          started_at: "2026-06-01T17:00:00.000Z",
          name: "FTP Test",
          canonical_type: "cycling",
          modality: "indoor",
          duration_seconds: 1200,
          identity: {
            identity: { kind: "activity_name", namespace: "cycling", value: "FTP Test" },
            strength: "caller_asserted",
            basis: "caller_asserted",
            confidence: "user_asserted",
            method: "exact_normalized_activity_name",
            assumptions: [],
          },
          moving_duration: {
            seconds: null,
            status: "not_available",
            evidence: [],
            evidence_count: 0,
            evidence_truncated: false,
          },
          route: {
            geometry: null,
            geometry_unavailable_reason: "No geometry comparison was performed.",
            quality: null,
            anchor_quality: null,
            source_providers: [],
            source_devices: [],
            anchor_activity_id: null,
            anchor_source_providers: [],
            anchor_source_devices: [],
            status: "not_available",
            provider: null,
            activity_name: null,
            provider_type: null,
            evidence: "comparison_not_keyed_by_route",
          },
          equivalence_evidence: [
            {
              evidence_type: "canonical_activity_name",
              provider: null,
              value: "FTP Test",
              field: "fitness.v_activity.name",
              provider_type: null,
              source_activity_id: ACTIVITY_ID,
              source_record_id: null,
            },
          ],
          equivalence_evidence_count: 1,
          equivalence_evidence_truncated: false,
          is_baseline: true,
          source_providers: ["wahoo"],
          source_provider_count: 1,
          source_external_ids: [],
          source_external_id_count: 0,
          member_activity_ids: [ACTIVITY_ID],
          member_activity_id_count: 1,
          activity_source_evidence_truncated: false,
          timezone: {
            value: "UTC",
            start_utc_offset_minutes: 0,
            local_time_source: "provider_timezone",
            analysis_timezone: "UTC",
            assumed: false,
          },
          metrics: {
            cycling_effort: null,
            cycling_effort_unavailable_reason: "No sample fixture.",
            cycling: null,
            climbing: null,
            strength: null,
            environment: {
              average_temperature_c: null,
              status: "not_available",
              value_kind: "calculated_from_deduped_samples",
            },
          },
          delta_to_baseline: {
            duration_seconds: 0,
            moving_duration_seconds: null,
            average_power_watts: null,
            normalized_power_watts: null,
            average_heart_rate_bpm: null,
            average_cadence_rpm: null,
            power_to_heart_rate_ratio: null,
            distance_meters: null,
            elevation_gain_meters: null,
            average_temperature_c: null,
            climbing_attempts: null,
            climbing_sends: null,
            strength_volume_kg_reps: null,
            strength_estimated_one_rep_max_kg: null,
          },
          quality: {
            comparable: true,
            flags: ["cycling_sensor_summary_unavailable"],
          },
          provenance: {
            value_kind: "mixed",
            activity_deduplication: "fitness.v_activity",
            sensor_deduplication: "analytics.activity_summary_rows/activity_sensor_sample FINAL",
            sample_source_providers: [],
            sample_source_provider_count: 0,
            sample_device_ids: [],
            sample_device_id_count: 0,
            sample_source_evidence_truncated: false,
          },
        },
      ],
      rejected_near_matches: {
        status: "not_evaluated",
        reason: "Fuzzy near matches are not searched.",
        items: [],
      },
      pagination: { limit: 10, has_more: false, next_cursor: null },
    });
    server = new McpServer({ name: "performance-comparison-test", version: "1.0.0" });
    registerPerformanceComparisonTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      sensorStore: { query: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    client = new Client({ name: "performance-comparison-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it.each([true, false])("preserves an explicit activity-name assertion of %s", (asserted) => {
    expect(
      toRepositoryEquivalence({
        kind: "activity_name",
        canonical_type: "cycling",
        value: "FTP Test",
        asserted,
      }),
    ).toEqual({
      kind: "activity_name",
      canonicalType: "cycling",
      value: "FTP Test",
      asserted,
    });
  });

  it("omits the activity-name assertion when the caller does not send it", () => {
    const equivalence = toRepositoryEquivalence({
      kind: "activity_name",
      canonical_type: "cycling",
      value: "FTP Test",
    });

    expect(Object.hasOwn(equivalence, "asserted")).toBe(false);
  });

  it("requires a reference or explicit key and forwards bounded filters", async () => {
    const invalid = await client.callTool({
      name: "compare_performances",
      arguments: { start_date: "2026-06-01", end_date: "2026-07-31" },
    });
    expect(invalid.isError).toBe(true);
    expect(mocks.compare).not.toHaveBeenCalled();

    const result = await client.callTool({
      name: "compare_performances",
      arguments: {
        start_date: "2026-06-01",
        end_date: "2026-07-31",
        equivalence: { kind: "activity_name", canonical_type: "cycling", value: "FTP Test" },
        providers: ["wahoo"],
        modalities: ["indoor"],
        limit: 10,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(mocks.compare).toHaveBeenCalledWith({
      startDate: "2026-06-01",
      endDate: "2026-07-31",
      referenceActivityId: null,
      equivalence: { kind: "activity_name", canonicalType: "cycling", value: "FTP Test" },
      providers: ["wahoo"],
      modalities: ["indoor"],
      cursor: null,
      limit: 10,
    });
  });

  it.each([
    { kind: "provider_workout", provider: "zwift", value: "workout-17" },
    { kind: "provider_route", provider: "garmin", value: "course-17" },
    { kind: "canonical_route", value: "route-fingerprint" },
    { kind: "segment", namespace: "strava", value: "segment-17" },
    { kind: "climb", namespace: "gym", value: "route-17" },
    { kind: "standardized_test", namespace: "protocol", value: "20-minute" },
    { kind: "user_defined_benchmark", value: ACTIVITY_ID },
  ])("accepts provider-neutral $kind evidence", async (equivalence) => {
    const result = await client.callTool({
      name: "compare_performances",
      arguments: { start_date: "2026-06-01", end_date: "2026-07-31", equivalence },
    });
    expect(result.isError).toBeFalsy();
    expect(mocks.compare).toHaveBeenCalledWith(expect.objectContaining({ equivalence }));
  });

  it("maps a provider-scoped standardized test name and provider type", async () => {
    const result = await client.callTool({
      name: "compare_performances",
      arguments: {
        start_date: "2026-06-01",
        end_date: "2026-07-31",
        equivalence: {
          kind: "standardized_test",
          provider: "wahoo",
          activity_name: "20 minute FTP test",
          provider_type: "cycling_test",
        },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mocks.compare).toHaveBeenCalledWith(
      expect.objectContaining({
        equivalence: {
          kind: "standardized_test",
          provider: "wahoo",
          activityName: "20 minute FTP test",
          providerType: "cycling_test",
        },
      }),
    );
  });
});
