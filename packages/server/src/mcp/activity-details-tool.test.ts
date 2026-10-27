import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { climbingSessionDetail } from "./test-helpers.ts";
import { activityDetailsOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ activity: vi.fn(), logs: vi.fn() }));
vi.mock("../repositories/activity-repository.ts", () => ({
  ActivityRepository: vi.fn(
    class {
      findById = mocks.activity;
    },
  ),
}));
vi.mock("../repositories/climbing-repository.ts", () => ({
  ClimbingRepository: vi.fn(
    class {
      getActivityLogEntries = mocks.logs;
    },
  ),
}));
vi.mock("../repositories/strength-repository.ts", () => ({
  StrengthRepository: vi.fn(
    class {
      getExercisesForActivity = async () => [];
    },
  ),
}));
vi.mock("../repositories/climbing-training-log-repository.ts", async (original) => ({
  ...(await original<typeof import("../repositories/climbing-training-log-repository.ts")>()),
  readFingerLoadingActivity: async () => [],
}));

import { registerActivityDetailsTool } from "./activity-details-tool.ts";

describe("get_activity_details response versions", () => {
  let server: McpServer;
  let client: Client;
  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.clearAllMocks();
  });

  it.each([undefined, 1, 2] as const)(
    "negotiates version %s before producing text and structured data",
    async (version) => {
      const id = "00000000-0000-4000-8000-000000000001";
      mocks.activity.mockResolvedValue({
        absent_source_external_ids: null,
        avg_cadence: null,
        avg_hr: null,
        avg_power: null,
        avg_speed: null,
        canonical_type: "climbing",
        distance_meters: null,
        elevation_gain_m: null,
        elevation_loss_m: null,
        ended_at: null,
        end_utc_offset_minutes: null,
        id,
        local_time_source: "unknown",
        location: null,
        max_hr: null,
        max_power: null,
        max_speed: null,
        modality: null,
        name: "Climbing",
        notes: null,
        perceived_exertion: null,
        provider_absent_at: null,
        primary_activity_id: null,
        primary_provider_id: null,
        primary_source_name: null,
        origin_candidate_member_ids: [],
        provider_id: "kaya",
        raw_type: "climbing",
        sample_count: 0,
        origin_evidence: [],
        source_external_ids: [],
        source_providers: ["kaya"],
        start_utc_offset_minutes: null,
        started_at: "2026-09-29T10:00:00Z",
        subsource: null,
        timezone: null,
        total_distance: null,
      });
      const base = climbingSessionDetail();
      const traits = [
        { holdTypes: ["crimp"], wallAngle: { value: 40, unit: "degrees" } },
        { holdTypes: ["crimp", "jug"], wallAngle: { category: "slab" } },
        { holdTypes: ["volume"], wallAngle: { value: -120, unit: null } },
        { holdTypes: ["jam"], wallAngle: null },
        { holdTypes: ["no_grips"], wallAngle: null },
      ];
      const logs = traits.map((trait) => ({ ...base, ...trait }));
      mocks.logs.mockResolvedValue(logs.map((log) => ({ toDetail: () => log })));
      server = new McpServer({ name: "activity-details", version: "1.0.0" });
      registerActivityDetailsTool(server, {
        db: { execute: vi.fn().mockResolvedValue([]), select: vi.fn(), transaction: vi.fn() },
        userId: id,
        scopes: ["activity:read"],
        timezone: "UTC",
      });
      client = new Client({ name: "activity-details-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "get_activity_details",
        arguments: {
          activity_id: id,
          ...(version === undefined ? {} : { response_version: version }),
        },
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const output = activityDetailsOutputSchema.parse(result.structuredContent).result;
      const { holdTypes: _holds, ...legacyBase } = base;
      expect(output.climbing_log_entries).toEqual(
        version === 2
          ? logs
          : [
              { ...legacyBase, holdType: "crimp", wallAngle: { value: 40, unit: "degrees" } },
              { ...legacyBase, holdType: null, wallAngle: null },
              { ...legacyBase, holdType: null, wallAngle: { value: -120, unit: null } },
              { ...legacyBase, holdType: null, wallAngle: null },
              { ...legacyBase, holdType: null, wallAngle: null },
            ],
      );
      const text = result.content[0];
      if (text?.type !== "text") throw new Error("Expected JSON text");
      expect({ result: JSON.parse(String(text.text)) }).toEqual(result.structuredContent);
    },
  );
});
