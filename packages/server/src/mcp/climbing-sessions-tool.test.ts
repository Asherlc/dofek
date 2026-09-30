import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { climbingSessionContext, climbingSessionDetail } from "./test-helpers.ts";
import { climbingSessionsOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn(), getActivityEntries: vi.fn() }));
vi.mock("../repositories/activity-repository.ts", () => ({
  ActivityRepository: vi.fn(() => ({ listRange: mocks.listRange })),
}));
vi.mock("../repositories/climbing-repository.ts", () => ({
  ClimbingRepository: vi.fn(() => ({ getActivityEntries: mocks.getActivityEntries })),
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
      },
    ]);
    mocks.getActivityEntries.mockResolvedValue([{ toDetail: () => climbingSessionDetail() }]);
    server = new McpServer({ name: "climbing-context", version: "1.0.0" });
    registerClimbingSessionsTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
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
    expect(result.isError).not.toBe(true);
    const output = climbingSessionsOutputSchema.parse(result.structuredContent);
    expect(output.result.sessions[0]?.climbs[0]).toMatchObject({
      context: climbingSessionContext(),
      discipline: "top_rope",
      sent: false,
      attempt_count: null,
    });
    expect(mocks.getActivityEntries).toHaveBeenCalledWith("activity-1");
  });
});
