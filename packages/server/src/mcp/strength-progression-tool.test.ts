import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strengthProgressionOutputSchema } from "./strength-progression-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn() }));

vi.mock("../repositories/strength-progression-repository.ts", () => ({
  StrengthProgressionRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.listRange };
  }),
}));

import { registerStrengthProgressionTool } from "./strength-progression-tool.ts";

const ACTIVITY_ID = "00000000-0000-4000-8000-000000000010";
const SOURCE_ACTIVITY_ID = "00000000-0000-4000-8000-000000000011";
const EXERCISE_ID = "00000000-0000-4000-8000-000000000012";
const SET_ID = "00000000-0000-4000-8000-000000000013";

function fixture() {
  return {
    range: { start_date: "2026-05-01", end_date: "2026-07-01", timezone: "UTC" },
    channel: {
      id: "strength" as const,
      interchangeable_with: [],
      note: "Separate load channel.",
    },
    definitions: {
      estimated_one_rep_max: "Epley definition.",
      volume: "Volume definition.",
      working_set: "Working-set definition.",
      anomaly_handling: "Anomaly definition.",
      duplicate_handling: "Duplicate definition.",
      personal_records: "PR definition.",
    },
    coverage: {
      sessions: 1,
      source_sets: 1,
      sets: 1,
      first_observed_date: "2026-05-01",
      timezone_assumed_sessions: 0,
      merged_exact_duplicate_records: 0,
      possible_duplicate_groups: 0,
      flagged_sets: 0,
      sets_excluded_from_volume: 0,
      sets_excluded_from_estimated_one_rep_max: 0,
    },
    summary: {
      sessions: 1,
      exercises: 1,
      frequency_days: 1,
      valid_working_sets: 1,
      total_volume_kg_reps: 500,
    },
    exercises: [
      {
        exercise_id: EXERCISE_ID,
        name: "Bench Press",
        equipment: "Barbell",
        muscle_groups: ["CHEST"],
        exercise_type: "STRENGTH",
        movement: "push",
        normalized_identity: true,
        frequency_days: 1,
        frequency_sessions: 1,
        working_sets: 1,
        valid_working_sets: 1,
        total_volume_kg_reps: 500,
        estimated_one_rep_max: {
          formula: "Epley" as const,
          first_kg: 116.67,
          latest_kg: 116.67,
          best_kg: 116.67,
          change_kg: 0,
          change_percent: 0,
          observations: [
            {
              date: "2026-05-01",
              value_kg: 116.67,
              set_id: SET_ID,
              activity_id: ACTIVITY_ID,
              weight_kg: 100,
              reps: 5,
            },
          ],
        },
        daily: [
          {
            date: "2026-05-01",
            sessions: 1,
            working_sets: 1,
            valid_working_sets: 1,
            total_volume_kg_reps: 500,
            max_weight_kg: 100,
            best_estimated_one_rep_max_kg: 116.67,
          },
        ],
        prs: [
          {
            date: "2026-05-01",
            value_kg: 116.67,
            set_id: SET_ID,
            activity_id: ACTIVITY_ID,
            weight_kg: 100,
            reps: 5,
            previous_best_kg: null,
            previous_best_evidence: null,
          },
        ],
      },
    ],
    sessions: [
      {
        activity_id: ACTIVITY_ID,
        date: "2026-05-01",
        started_at: "2026-05-01T18:00:00.000Z",
        duration_minutes: 60,
        name: "Bench",
        source_providers: ["strong"],
        source_external_ids: [
          {
            providerId: "strong",
            externalId: "bench-1",
            memberActivityId: SOURCE_ACTIVITY_ID,
          },
        ],
        member_activity_ids: [SOURCE_ACTIVITY_ID],
        timezone: {
          value: "America/Los_Angeles",
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "device_timezone",
          analysis_timezone: "UTC",
          assumed: false,
        },
        quality_flags: [],
        exercises: [
          {
            exercise_id: EXERCISE_ID,
            name: "Bench Press",
            equipment: "Barbell",
            muscle_groups: ["CHEST"],
            exercise_type: "STRENGTH",
            movement: "push",
            normalized_identity: true,
            sets: [
              {
                id: SET_ID,
                exercise_index: 0,
                set_index: 0,
                set_type: "working",
                is_warmup: false,
                is_working_set: true,
                normalized: {
                  weight_kg: 100,
                  reps: 5,
                  rpe: 8,
                  rir: null,
                  rir_status: "not_recorded_by_canonical_schema" as const,
                  distance_meters: null,
                  duration_seconds: null,
                  notes: null,
                },
                original: {
                  status: "available" as const,
                  values: { weight: 100, weightUnit: "kg", reps: 5 },
                  reason: null,
                  records: [
                    {
                      provider: "strong",
                      activity_id: SOURCE_ACTIVITY_ID,
                      set_id: SET_ID,
                      values: { weight: 100, weightUnit: "kg", reps: 5 },
                      source_exercise_identity: {
                        provider_exercise_id: null,
                        provider_exercise_name: "Bench Press (Barbell)",
                        status: "available" as const,
                      },
                    },
                  ],
                },
                volume: { status: "available" as const, value_kg_reps: 500, reason: null },
                estimated_one_rep_max: {
                  status: "available" as const,
                  value_kg: 116.67,
                  formula: "Epley" as const,
                  reason: null,
                },
                quality_flags: [],
                excluded_from_aggregates: false,
                provenance: {
                  value_kind: "mixed" as const,
                  source_set_ids: [SET_ID],
                  source_activity_ids: [SOURCE_ACTIVITY_ID],
                  source_providers: ["strong"],
                  merged_duplicate: false,
                  calculated_fields: ["volume_kg_reps", "estimated_one_rep_max"],
                },
              },
            ],
          },
        ],
      },
    ],
    pagination: { limit: 25, has_more: false, next_cursor: null },
  };
}

describe("get_strength_progression", () => {
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue(fixture());
    server = new McpServer({ name: "strength-progression-test", version: "1.0.0" });
    registerStrengthProgressionTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    client = new Client({ name: "strength-progression-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("passes exact-range provider and exercise filters to the repository", async () => {
    const result = await client.callTool({
      name: "get_strength_progression",
      arguments: {
        start_date: "2026-05-01",
        end_date: "2026-07-01",
        providers: ["strong"],
        exercise_ids: [EXERCISE_ID],
        limit: 25,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-05-01",
      endDate: "2026-07-01",
      providers: ["strong"],
      exerciseIds: [EXERCISE_ID],
      cursor: null,
      limit: 25,
    });
    expect(strengthProgressionOutputSchema.parse(result.structuredContent)).toEqual({
      result: fixture(),
    });
  });

  it("rejects reversed ranges before querying", async () => {
    const result = await client.callTool({
      name: "get_strength_progression",
      arguments: { start_date: "2026-08-01", end_date: "2026-07-01" },
    });

    expect(result.isError).toBe(true);
    expect(mocks.listRange).not.toHaveBeenCalled();
  });
});
