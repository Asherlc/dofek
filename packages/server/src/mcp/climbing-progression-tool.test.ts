import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { climbingProgressionOutputSchema } from "./climbing-progression-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn() }));

vi.mock("../repositories/climbing-progression-repository.ts", () => ({
  ClimbingProgressionRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.listRange };
  }),
}));

import { registerClimbingProgressionTool } from "./climbing-progression-tool.ts";

function fixture() {
  return {
    range: { start_date: "2026-07-01", end_date: "2026-07-31", timezone: "UTC" },
    definitions: {
      attempts: "Attempts definition",
      send_rate: "Send-rate definition",
      rolling_exposure: "Rolling definition",
      duplicate_handling: "Duplicate definition",
      volume_below_range_hardest_send: "Relative-volume definition",
    },
    coverage: {
      sessions: 1,
      entries: 1,
      entries_with_attempts: 0,
      entries_with_observed_outcome: 0,
      attempt_data: "unavailable" as const,
      first_observed_date: "2026-07-10",
      timezone_assumed_sessions: 1,
      merged_exact_duplicate_records: 0,
      possible_duplicate_groups: 0,
      entries_excluded_from_aggregates: 0,
    },
    daily: [
      {
        date: "2026-07-10",
        exposure_status: "observed" as const,
        sessions: 1,
        entries: 1,
        attempts: null,
        attempts_status: "unavailable" as const,
        sends: null,
        failed_entries: null,
        observed_outcomes: 0,
        send_rate: null,
        is_rest_day: false,
        consecutive_climbing_days: 1,
        rolling_7d_exposure_days: 1,
        rolling_28d_exposure_days: 1,
      },
    ],
    grade_distribution: [
      {
        discipline: "boulder" as const,
        grade: "V5",
        grade_system: "v_scale" as const,
        normalized_grade: "V5",
        normalized_grade_system: "v_scale" as const,
        grade_sort_value: 70,
        entries: 1,
        attempts: null,
        attempts_status: "unavailable" as const,
        entries_with_attempts: 0,
        sends: null,
        failed_entries: null,
        observed_outcomes: 0,
        send_rate: null,
        attempts_per_send: null,
      },
    ],
    grade_progression: [],
    hardest: { send: null, flash: null, onsight: null },
    below_range_hardest_send: {
      metric_name: "volume_below_range_hardest_send" as const,
      entries: 0,
      attempts: null,
      status: "unavailable" as const,
    },
    sessions: [
      {
        activity_id: "00000000-0000-4000-8000-000000000001",
        date: "2026-07-10",
        started_at: "2026-07-10T18:00:00.000Z",
        duration_minutes: 120,
        name: "Evening climbing",
        source_providers: ["kaya"],
        source_external_ids: [],
        member_activity_ids: ["00000000-0000-4000-8000-000000000011"],
        timezone: {
          value: null,
          start_utc_offset_minutes: null,
          end_utc_offset_minutes: null,
          local_time_source: "unknown",
          analysis_timezone: "UTC",
          assumed: true,
        },
        quality_flags: ["timezone_assumed_from_user_context"],
        climbs: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            discipline: "boulder" as const,
            climb_type: "boulder" as const,
            grade: "V5",
            grade_system: "v_scale" as const,
            normalized_grade: "V5",
            normalized_grade_system: "v_scale" as const,
            sent: null,
            attempt_count: null,
            attempts: [],
            ascent_type: null,
            lead: null,
            wall_angle_degrees: 30,
            hold_type: null,
            route_name: "Blue Arete",
            location_name: "Pacific Pipe",
            external_id: "problem-1",
            provenance: {
              value_kind: "measured" as const,
              source_entry_ids: ["00000000-0000-4000-8000-000000000101"],
              source_activity_ids: ["00000000-0000-4000-8000-000000000011"],
              source_providers: ["kaya"],
              source_names: ["Kaya"],
              source_external_entry_ids: [{ provider: "kaya", external_id: "problem-1" }],
              merged_duplicate: false,
            },
          },
        ],
      },
    ],
    pagination: { limit: 25, has_more: false, next_cursor: null },
  };
}

describe("get_climbing_progression", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue(fixture());
    server = new McpServer({ name: "climbing-progression-test", version: "1.0.0" });
    registerClimbingProgressionTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    client = new Client({ name: "climbing-progression-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("passes exact-range filters and returns the strict provenance-rich result", async () => {
    const result = await client.callTool({
      name: "get_climbing_progression",
      arguments: {
        start_date: "2026-07-01",
        end_date: "2026-07-31",
        providers: ["kaya"],
        disciplines: ["boulder"],
        locations: ["Pacific Pipe"],
        grade_systems: ["v_scale"],
        limit: 25,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      providers: ["kaya"],
      disciplines: ["boulder"],
      locations: ["Pacific Pipe"],
      gradeSystems: ["v_scale"],
      cursor: null,
      limit: 25,
    });
    expect(climbingProgressionOutputSchema.parse(result.structuredContent)).toEqual({
      result: fixture(),
    });
  });

  it("rejects reversed ranges before querying", async () => {
    const result = await client.callTool({
      name: "get_climbing_progression",
      arguments: { start_date: "2026-08-01", end_date: "2026-07-01" },
    });

    expect(result.isError).toBe(true);
    expect(mocks.listRange).not.toHaveBeenCalled();
  });
});
