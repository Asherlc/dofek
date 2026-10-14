import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  climbingSessionDetail,
  attachedRockClimbingObservationFixture as observation,
} from "./test-helpers.ts";
import { climbingSessionsOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({
  listRange: vi.fn(),
  getActivityLogEntries: vi.fn(),
  getAttachedRockObservations: vi.fn(),
}));
vi.mock("../repositories/activity-repository.ts", () => ({
  ActivityRepository: vi.fn(
    class {
      listRange = mocks.listRange;
    },
  ),
}));
vi.mock("../repositories/climbing-repository.ts", () => ({
  ClimbingRepository: vi.fn(
    class {
      getActivityLogEntries = mocks.getActivityLogEntries;
      getAttachedRockObservations = mocks.getAttachedRockObservations;
    },
  ),
}));

import { registerClimbingSessionsTool } from "./climbing-sessions-tool.ts";

describe("get_climbing_sessions context", () => {
  let client: Client;
  let server: McpServer;
  async function callTool() {
    server = new McpServer({ name: "climbing-context", version: "1.0.0" });
    registerClimbingSessionsTool(server, {
      db: { execute: vi.fn().mockResolvedValue([]), select: vi.fn(), transaction: vi.fn() },
      userId: "user-1",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    client = new Client({ name: "climbing-context-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "get_climbing_sessions",
      arguments: { start_date: "2026-09-01", end_date: "2026-09-30" },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return climbingSessionsOutputSchema.parse(result.structuredContent).result;
  }
  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.clearAllMocks();
  });
  it("retains climbing sessions and logged hikes, using the leaf shared area", async () => {
    const activity = {
      avg_hr: "120",
      ended_at: "2026-09-29T11:30:00Z",
      started_at: "2026-09-29T10:00:00Z",
      name: "Outing",
    };
    mocks.listRange.mockResolvedValue([
      { ...activity, id: "climb", canonical_type: "climbing" },
      { ...activity, id: "unlogged-hike", canonical_type: "hiking" },
      { ...activity, id: "logged-hike", canonical_type: "hiking" },
      { ...activity, id: "empty-path", canonical_type: "climbing" },
    ]);
    const detail = climbingSessionDetail();
    if (!detail.climb) throw new Error("Expected climb fixture");
    const area = detail.climb.areaPath[0];
    if (!area) throw new Error("Expected area fixture");
    const noClimb = { ...detail, climb: null, climbId: null };
    const noPath = { ...detail, climb: { ...detail.climb, areaPath: [] } };
    const deepPath = {
      ...detail,
      climb: {
        ...detail.climb,
        areaPath: ["Country", "Region", "Crag"].map((name) => ({ ...area, name })),
      },
    };
    mocks.getActivityLogEntries
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([noClimb, noPath, deepPath].map((log) => ({ toDetail: () => log })))
      .mockResolvedValueOnce([{ toDetail: () => noPath }]);
    mocks.getAttachedRockObservations.mockResolvedValue([]);
    const output = await callTool();
    expect(
      output.sessions.map(({ activity_id, location, avg_hr, duration_minutes, name }) => ({
        activity_id,
        location,
        avg_hr,
        duration_minutes,
        name,
      })),
    ).toEqual([
      { activity_id: "climb", location: null, avg_hr: 120, duration_minutes: 90, name: "Outing" },
      {
        activity_id: "logged-hike",
        location: "Crag",
        avg_hr: 120,
        duration_minutes: 90,
        name: "Outing",
      },
      {
        activity_id: "empty-path",
        location: null,
        avg_hr: 120,
        duration_minutes: 90,
        name: "Outing",
      },
    ]);
  });
  it("keeps an unknown total unknown across repeated grade buckets", async () => {
    mocks.listRange.mockResolvedValue([]);
    mocks.getAttachedRockObservations.mockResolvedValue([
      observation({ recordedAttempts: 2, sends: 1, observedOutcomes: 2, unknownOutcomes: 0 }),
      observation({ recordedAttempts: null, sends: 0, observedOutcomes: 0, unknownOutcomes: 1 }),
      observation({ recordedAttempts: 3, sends: 2, observedOutcomes: 3, unknownOutcomes: 0 }),
      observation({
        climbKind: "route",
        displayGrade: { grade: "5.10a", gradeSystem: "yds", gradeSortValue: 59 },
        recordedAttempts: 4,
        sends: 1,
        observedOutcomes: 4,
        unknownOutcomes: 0,
      }),
      observation({
        displayGrade: null,
        recordedAttempts: 1,
        sends: 0,
        observedOutcomes: 0,
        unknownOutcomes: 1,
      }),
    ]);
    expect((await callTool()).aggregates).toEqual({
      grade_distribution: [
        {
          climb_kind: "boulder",
          grade: "V5",
          grade_system: "v_scale",
          recorded_attempts: null,
          sends: 3,
        },
        {
          climb_kind: "route",
          grade: "5.10a",
          grade_system: "yds",
          recorded_attempts: 4,
          sends: 1,
        },
      ],
      send_rate: 4 / 9,
      max_grade_by_kind: { boulder: "V5", route: "5.10a" },
      volume: { rock_log_entries: 5, recorded_attempts: null, sends: 4 },
      coverage: {
        rock_log_entries: 5,
        observed_free_send_outcomes: 9,
        unknown_free_send_outcomes: 2,
      },
    });
  });
  it("chooses the hardest confirmed sends without counting harder failed climbs", async () => {
    mocks.listRange.mockResolvedValue([]);
    mocks.getAttachedRockObservations.mockResolvedValue([
      ...[
        { grade: "V9", gradeSortValue: 90, sends: 0 },
        { grade: "V6", gradeSortValue: 75, sends: 1 },
        { grade: "V4", gradeSortValue: 65, sends: 1 },
        { grade: "V10", gradeSortValue: 95, sends: 0 },
      ].map(({ grade, gradeSortValue, sends }) =>
        observation({ displayGrade: { grade, gradeSystem: "v_scale", gradeSortValue }, sends }),
      ),
      observation({
        climbKind: "route",
        displayGrade: { grade: "5.10a", gradeSystem: "yds", gradeSortValue: 59 },
        sends: 0,
      }),
    ]);
    expect((await callTool()).aggregates.max_grade_by_kind).toEqual({ boulder: "V6", route: null });
  });
  it("returns zero participation and unavailable send rate for no observations", async () => {
    mocks.listRange.mockResolvedValue([]);
    mocks.getAttachedRockObservations.mockResolvedValue([]);
    expect((await callTool()).aggregates).toEqual({
      grade_distribution: [],
      send_rate: null,
      max_grade_by_kind: { boulder: null, route: null },
      volume: { rock_log_entries: 0, recorded_attempts: 0, sends: 0 },
      coverage: {
        rock_log_entries: 0,
        observed_free_send_outcomes: 0,
        unknown_free_send_outcomes: 0,
      },
    });
  });
  it("returns the same context as activity details after MCP output validation", async () => {
    mocks.listRange.mockResolvedValue([
      {
        id: "activity-1",
        avg_hr: null,
        ended_at: null,
        started_at: "2026-09-29T10:00:00Z",
        name: null,
        canonical_type: "climbing",
      },
    ]);
    mocks.getActivityLogEntries.mockResolvedValue([{ toDetail: () => climbingSessionDetail() }]);
    mocks.getAttachedRockObservations.mockResolvedValue([
      {
        activityId: "activity-1",
        date: "2026-09-29",
        climbKind: "route",
        attemptScope: "climb",
        displayGrade: { grade: "5.10a", gradeSystem: "yds", gradeSortValue: 61 },
        recordedAttempts: 1,
        sends: 0,
        observedOutcomes: 1,
        unknownOutcomes: 0,
      },
    ]);
    server = new McpServer({ name: "climbing-context", version: "1.0.0" });
    registerClimbingSessionsTool(server, {
      db: { execute: vi.fn().mockResolvedValue([]), select: vi.fn(), transaction: vi.fn() },
      userId: "user-1",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    client = new Client({ name: "climbing-context-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "get_climbing_sessions",
      arguments: { start_date: "2026-09-01", end_date: "2026-09-30" },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const output = climbingSessionsOutputSchema.parse(result.structuredContent);
    expect(output.result.sessions[0]?.climbing_log_entries[0]).toEqual(climbingSessionDetail());
    expect(output.result.aggregates.volume).toEqual({
      rock_log_entries: 1,
      recorded_attempts: 1,
      sends: 0,
    });
    expect(mocks.getActivityLogEntries).toHaveBeenCalledWith("activity-1");
    expect(mocks.getAttachedRockObservations).toHaveBeenCalledWith("2026-09-01", "2026-09-30");
  });
});
