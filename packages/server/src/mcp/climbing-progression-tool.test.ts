import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { climbingAttemptFixture } from "../repositories/climbing-test-helpers.ts";
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
      entries_with_attempts: 1,
      observed_free_send_outcomes: 0,
      unknown_free_send_outcomes: 1,
      attempt_data: "complete" as const,
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
        attempts: 1,
        attempts_status: "complete" as const,
        sends: null,
        failed_attempts: 0,
        observed_outcomes: 0,
        unknown_outcomes: 1,
        send_rate: null,
        is_rest_day: false,
        consecutive_climbing_days: 1,
        rolling_7d_exposure_days: 1,
        rolling_28d_exposure_days: 1,
      },
    ],
    grade_distribution: [
      {
        climb_kind: "boulder" as const,
        attempt_scope: "climb" as const,
        rope_method: null,
        solo: null,
        used_aid: null,
        grade: "V5",
        grade_system: "v_scale" as const,
        normalized_grade: "V5",
        normalized_grade_system: "v_scale" as const,
        grade_sort_value: 70,
        entries: 1,
        attempts: 1,
        attempts_status: "complete" as const,
        entries_with_attempts: 1,
        sends: null,
        failed_attempts: 0,
        observed_outcomes: 0,
        unknown_outcomes: 1,
        send_rate: null,
        attempts_per_send: null,
      },
    ],
    grade_progression: [],
    hardest: { send: null, flash: null, onsight: null },
    below_range_hardest_send: {
      metric_name: "volume_below_range_hardest_send" as const,
      entries: 0,
      attempts: 1,
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
        climbing_log_entries: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            pitch_id: null,
            pitch_number: null,
            attempt_scope: "climb" as const,
            rope_method: null,
            solo: null,
            used_aid: null,
            climb_kind: "boulder" as const,
            grade: "V5",
            grade_system: "v_scale" as const,
            normalized_grade: "V5",
            normalized_grade_system: "v_scale" as const,
            sends: 0,
            unknown_outcomes: 1,
            recorded_attempt_count: 1,
            attempts: [
              (() => {
                const { rockResultLabels, ...attempt } = climbingAttemptFixture(
                  "00000000-0000-4000-8000-000000000101",
                );
                return attempt;
              })(),
            ],
            rock_result_labels: { onsight: null, flash: null },
            wall_angle_degrees: 30,
            hold_types: null,
            climb_name: "Blue Arete",
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
      db: { execute: vi.fn().mockResolvedValue([]), select: vi.fn(), transaction: vi.fn() },
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
        response_version: 2,
        start_date: "2026-07-01",
        end_date: "2026-07-31",
        providers: ["kaya"],
        filters: { climbKind: "boulder" },
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
      filters: { climbKind: "boulder" },
      locations: ["Pacific Pipe"],
      gradeSystems: ["v_scale"],
      cursor: null,
      limit: 25,
    });
    expect(climbingProgressionOutputSchema.parse(result.structuredContent)).toEqual({
      result: fixture(),
    });
  });

  it.each([undefined, 1, 2] as const)(
    "negotiates grip responses for version %s",
    async (version) => {
      const source = fixture();
      const first = source.sessions[0]?.climbing_log_entries[0];
      if (!first) throw new Error("Expected progression fixture");
      const holds = [["crimp"], ["jug", "crimp"], ["volume"], ["jam"], ["no_grips"], null];
      mocks.listRange.mockResolvedValue({
        ...source,
        sessions: source.sessions.map((session) => ({
          ...session,
          climbing_log_entries: holds.map((hold_types) => ({ ...first, hold_types })),
        })),
      });
      const result = await client.callTool({
        name: "get_climbing_progression",
        arguments: {
          start_date: "2026-07-01",
          end_date: "2026-07-31",
          ...(version === undefined ? {} : { response_version: version }),
        },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const parsed = climbingProgressionOutputSchema.parse(result.structuredContent);
      const { hold_types: _holds, ...rest } = first;
      expect(parsed.result.sessions[0]?.climbing_log_entries).toEqual(
        version === 2
          ? holds.map((hold_types) => ({ ...rest, hold_types }))
          : ["crimp", null, null, null, null, null].map((hold_type) => ({ ...rest, hold_type })),
      );
      const text = result.content[0];
      if (text?.type !== "text") throw new Error("Expected JSON text");
      expect(JSON.parse(String(text.text))).toEqual(parsed.result);
    },
  );

  it("rejects reversed ranges before querying", async () => {
    const result = await client.callTool({
      name: "get_climbing_progression",
      arguments: { start_date: "2026-08-01", end_date: "2026-07-01" },
    });

    expect(result.isError).toBe(true);
    expect(mocks.listRange).not.toHaveBeenCalled();
  });
});
