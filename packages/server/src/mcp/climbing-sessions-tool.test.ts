import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { climbingSessionDetail } from "./test-helpers.ts";
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
  afterEach(async () => {
    await client?.close();
    await server?.close();
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
