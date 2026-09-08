import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cyclingPowerCurveOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn() }));

vi.mock("../repositories/cycling-power-curve-repository.ts", () => ({
  CyclingPowerCurveRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.listRange };
  }),
}));

import { registerCyclingPowerCurveTool } from "./cycling-power-curve-tool.ts";

const activityId = "00000000-0000-4000-8000-000000000010";

function page() {
  return {
    start_date: "2026-03-01",
    end_date: "2026-08-28",
    durations_seconds: [300, 1200],
    bests: [
      {
        duration_seconds: 300,
        watts: 350,
        watts_per_kg: 5,
        watts_per_kg_reason: null,
        weight: {
          value_kg: 70,
          kind: "measured" as const,
          method: "same_day" as const,
          quality: "high" as const,
          distance_days: 0,
          sources: [
            {
              date: "2026-08-01",
              recorded_at: "2026-08-01T08:00:00.000Z",
              value_kg: 70,
              provider: "withings",
              source_record_id: "weight-1",
              measurement_kind: "direct" as const,
            },
          ],
        },
        activity_id: activityId,
        date: "2026-08-01",
        started_at: "2026-08-01T15:00:00.000Z",
        start_offset_seconds: 30,
        canonical_type: "cycling",
        power_kind: "direct" as const,
        source_providers: ["wahoo"],
        source_devices: ["elemnt-bolt"],
        member_activity_ids: [activityId],
        quality: {
          status: "high" as const,
          reasons: [],
          observed_samples: 301,
          coverage_pct: 100,
          continuity_tolerance_seconds: 5,
          median_sample_interval_seconds: 1,
          largest_gap_seconds: 1,
        },
      },
    ],
    activity_curve: [],
    next_cursor: null,
  };
}

describe("get_cycling_power_curve", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue(page());
    server = new McpServer({ name: "cycling-power-curve-test", version: "1.0.0" });
    registerCyclingPowerCurveTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "America/Los_Angeles",
      sensorStore: { query: vi.fn() },
    });
    client = new Client({ name: "cycling-power-curve-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("applies the standard defaults and returns strictly parsed evidence", async () => {
    const result = await client.callTool({
      name: "get_cycling_power_curve",
      arguments: { start_date: "2026-03-01", end_date: "2026-08-28" },
    });

    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-03-01",
      endDate: "2026-08-28",
      durationsSeconds: [1, 5, 15, 30, 60, 120, 300, 600, 720, 1200, 1800, 2400, 3600, 5400],
      modalities: [],
      providers: [],
      includeActivityCurve: false,
      cursor: null,
      limit: 100,
    });
    const parsed = cyclingPowerCurveOutputSchema.parse(result.structuredContent);
    expect(parsed.result.bests[0]).toMatchObject({
      activity_id: activityId,
      duration_seconds: 300,
      watts: 350,
      watts_per_kg: 5,
      power_kind: "direct",
      quality: { continuity_tolerance_seconds: 5 },
      source_providers: ["wahoo"],
      member_activity_ids: [activityId],
    });
    expect(
      cyclingPowerCurveOutputSchema.safeParse({
        ...result.structuredContent,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("sorts requested durations and passes filters and pagination through", async () => {
    await client.callTool({
      name: "get_cycling_power_curve",
      arguments: {
        start_date: "2026-03-01",
        end_date: "2026-08-28",
        durations_seconds: [421, 5, 1200],
        modalities: ["virtual", "outdoor"],
        providers: ["peloton", "wahoo"],
        include_activity_curve: true,
        cursor: "next-page",
        limit: 250,
      },
    });

    expect(mocks.listRange).toHaveBeenCalledWith({
      startDate: "2026-03-01",
      endDate: "2026-08-28",
      durationsSeconds: [5, 421, 1200],
      modalities: ["virtual", "outdoor"],
      providers: ["peloton", "wahoo"],
      includeActivityCurve: true,
      cursor: "next-page",
      limit: 250,
    });
  });

  it.each([
    {
      name: "reversed date range",
      arguments: { start_date: "2026-08-29", end_date: "2026-08-28" },
      message: "start_date must be on or before end_date",
    },
    {
      name: "duplicate durations",
      arguments: {
        start_date: "2026-03-01",
        end_date: "2026-08-28",
        durations_seconds: [300, 300],
      },
      message: "durations must be unique",
    },
    {
      name: "duration above six hours",
      arguments: {
        start_date: "2026-03-01",
        end_date: "2026-08-28",
        durations_seconds: [21_601],
      },
      message: "21600",
    },
    {
      name: "more than 32 durations",
      arguments: {
        start_date: "2026-03-01",
        end_date: "2026-08-28",
        durations_seconds: Array.from({ length: 33 }, (_, index) => index + 1),
      },
      message: "32",
    },
  ])("rejects $name", async ({ arguments: callArguments, message }) => {
    const result = await client.callTool({
      name: "get_cycling_power_curve",
      arguments: callArguments,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining(message) }),
    ]);
    expect(mocks.listRange).not.toHaveBeenCalled();
  });

  it("fails specifically when ClickHouse is unavailable", async () => {
    const unavailableServer = new McpServer({ name: "unavailable", version: "1.0.0" });
    registerCyclingPowerCurveTool(unavailableServer, {
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
      name: "get_cycling_power_curve",
      arguments: { start_date: "2026-03-01", end_date: "2026-08-28" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "get_cycling_power_curve requires the ClickHouse analytics store",
        ),
      }),
    ]);
    expect(mocks.listRange).not.toHaveBeenCalled();
    await unavailableClient.close();
    await unavailableServer.close();
  });

  it("enforces activity read scope", async () => {
    const deniedServer = new McpServer({ name: "denied", version: "1.0.0" });
    registerCyclingPowerCurveTool(deniedServer, {
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
      name: "get_cycling_power_curve",
      arguments: { start_date: "2026-03-01", end_date: "2026-08-28" },
    });
    expect(result.isError).toBe(true);
    expect(mocks.listRange).not.toHaveBeenCalled();
    await deniedClient.close();
    await deniedServer.close();
  });
});
