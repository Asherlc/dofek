import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityTimeseriesOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../repositories/activity-timeseries-repository.ts", () => ({
  ActivityTimeseriesRepository: vi.fn(function vitestConstructor() {
    return { list: mocks.list };
  }),
}));

import { registerActivityTimeseriesTool } from "./activity-timeseries-tool.ts";

const activityId = "00000000-0000-4000-8000-000000000001";
const startedAt = "2026-09-01T10:00:00.000Z";

function page() {
  return {
    activity: {
      id: activityId,
      startedAt,
      endedAt: "2026-09-01T11:00:00.000Z",
      sourceProviders: ["wahoo"],
      memberActivityIds: [activityId],
      localTimeContext: {
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        source: "provider_timezone" as const,
      },
    },
    resolution: { requested: "5s" as const, effectiveSeconds: 5 },
    offsetsSeconds: [0, 5, 10],
    timestamps: [startedAt, "2026-09-01T10:00:05.000Z", "2026-09-01T10:00:10.000Z"],
    streams: {
      power: {
        values: [0, null, 225],
        states: ["aggregated_zero", "missing", "aggregated"] as const,
        sourceIndexes: [[0], null, [0]],
        unit: "W",
        summary: {
          min: 0,
          max: 225,
          average: 112.5,
          observedSamples: 2,
          missingPoints: 1,
          zeroPoints: 1,
          largestGapSeconds: 10,
        },
        availabilityReason: null,
      },
    },
    sources: [
      {
        provider_id: "wahoo",
        device_id: "KICKR",
        source_type: "fit",
        source_record_id: "power-stream",
        activity_id: activityId,
        member_activity_id: activityId,
        measurement_kind: "direct" as const,
      },
    ],
    nextCursor: null,
  };
}

describe("get_activity_timeseries", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.list.mockReset().mockResolvedValue(page());
    server = new McpServer({ name: "activity-timeseries-test", version: "1.0.0" });
    registerActivityTimeseriesTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "America/Los_Angeles",
      sensorStore: { query: vi.fn() },
    });
    client = new Client({ name: "activity-timeseries-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("applies compact defaults and preserves zero, null, and state arrays", async () => {
    const result = await client.callTool({
      name: "get_activity_timeseries",
      arguments: { activity_id: activityId, streams: ["power"] },
    });

    expect(mocks.list).toHaveBeenCalledWith({
      activityId,
      streams: ["power"],
      resolution: "raw",
      fill: "none",
      cursor: null,
      limit: 500,
    });
    const parsed = activityTimeseriesOutputSchema.parse(result.structuredContent);
    expect(parsed.result.streams.power?.values).toEqual([0, null, 225]);
    expect(parsed.result.streams.power?.states).toEqual([
      "aggregated_zero",
      "missing",
      "aggregated",
    ]);
  });

  it("passes selected streams, resolution, fill, cursor, and limit through", async () => {
    await client.callTool({
      name: "get_activity_timeseries",
      arguments: {
        activity_id: activityId,
        streams: ["power", "heart_rate"],
        resolution: "5s",
        fill: "linear",
        cursor: "cursor",
        limit: 2_000,
      },
    });

    expect(mocks.list).toHaveBeenCalledWith({
      activityId,
      streams: ["power", "heart_rate"],
      resolution: "5s",
      fill: "linear",
      cursor: "cursor",
      limit: 2_000,
    });
  });

  it("surfaces malformed cursor errors without changing their meaning", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Invalid analytical cursor"));

    const result = await client.callTool({
      name: "get_activity_timeseries",
      arguments: { activity_id: activityId, streams: ["power"], cursor: "malformed" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Invalid analytical cursor") }),
    ]);
  });

  it("fails specifically when ClickHouse is unavailable", async () => {
    const unavailableServer = new McpServer({ name: "unavailable", version: "1.0.0" });
    registerActivityTimeseriesTool(unavailableServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    const unavailableClient = new Client({ name: "unavailable-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await unavailableServer.connect(serverTransport);
    await unavailableClient.connect(clientTransport);

    const result = await unavailableClient.callTool({
      name: "get_activity_timeseries",
      arguments: { activity_id: activityId, streams: ["power"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "get_activity_timeseries requires the ClickHouse analytics store",
        ),
      }),
    ]);
    expect(mocks.list).not.toHaveBeenCalled();
    await unavailableClient.close();
    await unavailableServer.close();
  });

  it("enforces activity read scope", async () => {
    const deniedServer = new McpServer({ name: "denied", version: "1.0.0" });
    registerActivityTimeseriesTool(deniedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["health:read"],
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    const deniedClient = new Client({ name: "denied-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await deniedServer.connect(serverTransport);
    await deniedClient.connect(clientTransport);

    const result = await deniedClient.callTool({
      name: "get_activity_timeseries",
      arguments: { activity_id: activityId, streams: ["power"] },
    });
    expect(result.isError).toBe(true);
    expect(mocks.list).not.toHaveBeenCalled();
    await deniedClient.close();
    await deniedServer.close();
  });
});
