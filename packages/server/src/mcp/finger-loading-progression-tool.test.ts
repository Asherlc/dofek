import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerLoadingProgressionOutputSchema } from "./finger-loading-progression-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn() }));

vi.mock("../repositories/finger-loading-progression-repository.ts", () => ({
  FingerLoadingProgressionRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.listRange };
  }),
}));

import { registerFingerLoadingProgressionTool } from "./finger-loading-progression-tool.ts";

const ACTIVITY_ID = "00000000-0000-4000-8000-000000000010";
const SOURCE_ACTIVITY_ID = "00000000-0000-4000-8000-000000000011";
const ENTRY_ID = "00000000-0000-4000-8000-000000000100";

function fixture() {
  return {
    range: { start_date: "2026-07-10", end_date: "2026-07-10", timezone: "UTC" },
    channel: {
      id: "finger_loading" as const,
      interchangeable_with: [],
      note: "Separate load channel.",
    },
    definitions: {
      effective_load: "Effective load definition.",
      time_under_tension: "TUT definition.",
      effective_load_kg_seconds: "Exposure definition.",
      high_intensity: "Threshold definition.",
      duplicate_handling: "Dedup definition.",
      consecutive_days: "Consecutive definition.",
    },
    coverage: {
      sessions: 1,
      entries: 1,
      first_observed_date: "2026-07-10",
      timezone_assumed_sessions: 0,
      merged_exact_duplicate_records: 0,
      possible_duplicate_groups: 0,
      entries_excluded_from_aggregates: 0,
    },
    summary: {
      sessions: 1,
      entries: 1,
      total_time_under_tension_seconds: null,
      effective_load_kg_seconds: null,
      exposure_calculation: {
        status: "unavailable" as const,
        reason: "Repetitions are unavailable.",
      },
      max_effective_load_kg: 100,
      max_load_to_bodyweight_ratio: 1.25,
    },
    high_intensity: {
      status: "available" as const,
      thresholds: {
        min_effective_load_kg: 95,
        min_load_to_bodyweight_ratio: null,
        min_rpe: 9,
      },
      matching_entries: 1,
      days: 1,
      reason: null,
    },
    daily: [
      {
        date: "2026-07-10",
        exposure_status: "observed" as const,
        sessions: 1,
        entries: 1,
        entries_in_aggregates: 1,
        total_time_under_tension_seconds: null,
        effective_load_kg_seconds: null,
        max_effective_load_kg: 100,
        max_load_to_bodyweight_ratio: 1.25,
        high_intensity_entries: 1,
        high_intensity_day: true,
        is_rest_day: false,
        consecutive_finger_loading_days: 1,
      },
    ],
    sessions: [
      {
        activity_id: ACTIVITY_ID,
        date: "2026-07-10",
        started_at: "2026-07-10T18:00:00.000Z",
        duration_minutes: 30,
        name: "Max hangs",
        source_providers: ["manual"],
        source_external_ids: [
          {
            providerId: "manual",
            externalId: "hang-1",
            memberActivityId: SOURCE_ACTIVITY_ID,
          },
        ],
        member_activity_ids: [SOURCE_ACTIVITY_ID],
        timezone: {
          value: "America/Los_Angeles",
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_timezone",
          analysis_timezone: "UTC",
          assumed: false,
        },
        quality_flags: [],
        entries: [
          {
            id: ENTRY_ID,
            protocol: "max_hang" as const,
            grip_type: "half_crimp" as const,
            edge_size_mm: 20,
            original_external_load_kg: 20,
            added_weight_kg: 20,
            assistance_kg: 0,
            bodyweight_kg: 80,
            effective_load_kg: 100,
            load_to_bodyweight_ratio: 1.25,
            hang_duration_seconds: 10,
            rest_duration_seconds: 180,
            pain: null,
            pain_status: "not_recorded_by_canonical_schema" as const,
            repetitions_per_set: null,
            repetitions_status: "not_recorded_by_canonical_schema" as const,
            sets: 5,
            laterality: "both" as const,
            rpe: 9,
            notes: null,
            total_time_under_tension_seconds: null,
            effective_load_kg_seconds: null,
            exposure_calculation: {
              status: "unavailable" as const,
              reason: "Repetitions are unavailable.",
            },
            high_intensity: true,
            excluded_from_aggregates: false,
            quality_flags: [],
            provenance: {
              value_kind: "mixed" as const,
              source_recorded_fields: ["bodyweight_kg"],
              calculated_fields: ["effective_load_kg"],
              source_entry_ids: [ENTRY_ID],
              source_activity_ids: [SOURCE_ACTIVITY_ID],
              source_providers: ["manual"],
              merged_duplicate: false,
            },
          },
        ],
      },
    ],
    combined_climbing_finger_exposure: {
      definition: "Calendar exposure without numeric load combination.",
      first_joint_coverage_date: "2026-07-10",
      daily: [
        {
          date: "2026-07-10",
          finger_loading: true,
          finger_loading_status: "observed" as const,
          climbing: false,
          climbing_status: "not_observed" as const,
          any_exposure: true,
          exposure_status: "observed" as const,
          consecutive_exposure_days: 1,
        },
      ],
    },
    pagination: { limit: 25, has_more: false, next_cursor: null },
  };
}

describe("get_finger_loading_progression", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue(fixture());
    server = new McpServer({ name: "finger-loading-progression-test", version: "1.0.0" });
    registerFingerLoadingProgressionTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    client = new Client({ name: "finger-loading-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("passes exact-range filters and explicit thresholds to the repository", async () => {
    const result = await client.callTool({
      name: "get_finger_loading_progression",
      arguments: {
        start_date: "2026-07-10",
        end_date: "2026-07-10",
        providers: ["manual"],
        protocols: ["max_hang"],
        min_effective_load_kg: 95,
        min_rpe: 9,
        limit: 25,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: ["manual"],
      exercises: ["max_hang"],
      thresholds: {
        minEffectiveLoadKg: 95,
        minLoadToBodyweightRatio: null,
        minRpe: 9,
      },
      cursor: null,
      limit: 25,
    });
    expect(fingerLoadingProgressionOutputSchema.parse(result.structuredContent)).toEqual({
      result: fixture(),
    });
  });

  it("rejects reversed ranges before querying", async () => {
    const result = await client.callTool({
      name: "get_finger_loading_progression",
      arguments: { start_date: "2026-08-01", end_date: "2026-07-01" },
    });

    expect(result.isError).toBe(true);
    expect(mocks.listRange).not.toHaveBeenCalled();
  });
});
