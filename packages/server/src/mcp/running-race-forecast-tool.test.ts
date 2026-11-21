import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";
import type { DofekMcpContext } from "./context.ts";
import { registerRunningRaceForecastTool } from "./running-race-forecast-tool.ts";

const source = {
  source_activity_id: "42",
  provider_id: "runalyze",
  source_name: "Spring 5K",
  source_date_time: "2026-05-01T00:30:00+02:00",
  date: "2026-05-01",
  distance_meters: 5000,
  finish_seconds: 1500,
};
const range = { start_date: "2026-05-01", end_date: "2026-05-01" };

async function withForecast(
  execute: DofekMcpContext["db"]["execute"],
  scopes: DofekMcpContext["scopes"],
  check: (client: Client) => Promise<void>,
) {
  const server = new McpServer({ name: "forecast-server", version: "1.0.0" });
  const client = new Client({ name: "forecast-client", version: "1.0.0" });
  registerRunningRaceForecastTool(server, {
    db: { execute, select: vi.fn(), transaction: vi.fn() },
    userId: "00000000-0000-4000-8000-000000000001",
    clientId: "test-client",
    scopes,
    timezone: "America/Los_Angeles",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await check(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const name = "get_running_race_forecast";

it("advertises a read-only, non-destructive tool with no open-world interaction", async () => {
  await withForecast(vi.fn(), ["activity:read"], async (client) => {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    });
  });
});

it.each([
  ["2026-04-30", "2026-04-30"],
  ["2026-05-02", "2026-05-01"],
])("bounds the query's end date %s to %s in the context timezone", async (endDate, boundedEnd) => {
  const execute = vi.fn().mockResolvedValue([]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-05-02T01:00:00Z"));
  try {
    await withForecast(execute, ["activity:read"], async (client) => {
      const result = await client.callTool({
        name,
        arguments: { start_date: "2026-04-01", end_date: endDate, target: "half_marathon" },
      });
      expect(result.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]).params).toEqual([
        "00000000-0000-4000-8000-000000000001",
        "2026-04-01",
        boundedEnd,
        5000,
        8046.72,
        10000,
        16093.44,
        21097.5,
      ]);
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ["10k", 10000, 3149.150050869202],
  ["half_marathon", 21097.5, 7000.362338490406],
] as const)("forecasts %s from a traceable 25-minute 5K", async (target, distance, estimate) => {
  await withForecast(vi.fn().mockResolvedValue([source]), ["activity:read"], async (client) => {
    const result = await client.callTool({ name, arguments: { ...range, target } });
    expect(result.structuredContent).toMatchObject({
      result: {
        status: "estimated",
        target,
        target_distance_meters: distance,
        estimated_finish_seconds: expect.closeTo(estimate, 10),
        method: { exponent: 1.07, citation_url: "https://doi.org/10.1186/s13102-016-0052-y" },
        source,
      },
    });
  });
});

it("reports that the forecast is unavailable when there is no eligible source", async () => {
  await withForecast(vi.fn().mockResolvedValue([]), ["activity:read"], async (client) => {
    const result = await client.callTool({ name, arguments: { ...range, target: "10k" } });
    expect(result.structuredContent).toMatchObject({ result: { status: "unavailable" } });
  });
});

it("requires activity read consent before querying the database", async () => {
  const execute = vi.fn();
  await withForecast(execute, ["health:read"], async (client) => {
    const result = await client.callTool({ name, arguments: { ...range, target: "10k" } });
    expect(result.isError).toBe(true);
    expect(result._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringContaining("activity:read"),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
});

it("rejects reversed ranges and unsupported targets", async () => {
  const execute = vi.fn();
  await withForecast(execute, ["activity:read"], async (client) => {
    for (const args of [
      { ...range, target: "marathon" },
      { start_date: "2026-05-02", end_date: "2026-05-01", target: "10k" },
    ]) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
