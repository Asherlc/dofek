import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cyclingThresholdEstimateOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ estimate: vi.fn() }));

vi.mock("../repositories/cycling-threshold-estimator.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../repositories/cycling-threshold-estimator.ts")>();
  return {
    ...original,
    CyclingThresholdEstimator: vi.fn(function vitestConstructor() {
      return { estimate: mocks.estimate };
    }),
  };
});

import { registerCyclingThresholdEstimateTool } from "./cycling-threshold-estimate-tool.ts";

function response() {
  return {
    start_date: "2026-05-01",
    end_date: "2026-08-01",
    requested_method: "twenty_minute_95_percent" as const,
    result: {
      threshold_watts: 285,
      watts_per_kg: null,
      watts_per_kg_reason: "No directly measured body weight within 30 days",
      method: "twenty_minute_95_percent" as const,
      classification: "estimated" as const,
      confidence: "moderate" as const,
      uncertainty: {
        watts: null,
        kind: "not_quantifiable" as const,
        reason: "A single heuristic has no statistical interval",
      },
      evidence: { threshold_history: [], efforts: [] },
      relevant_activity_ids: [],
      assumptions: ["FTP is estimated as 95% of maximal 20-minute power"],
      model: null,
    },
    unavailable_reason: null,
    weight: {
      value_kg: null as const,
      reason: "No directly measured body weight within 30 days",
    },
  };
}

describe("estimate_cycling_threshold", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.estimate.mockReset().mockResolvedValue(response());
    server = new McpServer({ name: "threshold-estimate-test", version: "1.0.0" });
    registerCyclingThresholdEstimateTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      scopes: ["activity:read"],
      timezone: "America/Los_Angeles",
      sensorStore: { query: vi.fn() },
    });
    client = new Client({ name: "threshold-estimate-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("passes a labeled method and source filters and strictly parses the result", async () => {
    const result = await client.callTool({
      name: "estimate_cycling_threshold",
      arguments: {
        start_date: "2026-05-01",
        end_date: "2026-08-01",
        method: "twenty_minute_95_percent",
        providers: ["wahoo"],
        modalities: ["outdoor"],
      },
    });

    expect(mocks.estimate).toHaveBeenCalledWith({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      method: "twenty_minute_95_percent",
      providers: ["wahoo"],
      modalities: ["outdoor"],
    });
    expect(
      cyclingThresholdEstimateOutputSchema.parse(result.structuredContent).result.result,
    ).toMatchObject({
      threshold_watts: 285,
      classification: "estimated",
      uncertainty: { kind: "not_quantifiable" },
    });
    expect(
      cyclingThresholdEstimateOutputSchema.safeParse({
        ...result.structuredContent,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("defaults to best_supported", async () => {
    await client.callTool({
      name: "estimate_cycling_threshold",
      arguments: { start_date: "2026-05-01", end_date: "2026-08-01" },
    });
    expect(mocks.estimate).toHaveBeenCalledWith(
      expect.objectContaining({ method: "best_supported", providers: [], modalities: [] }),
    );
  });

  it("validates dates and requires ClickHouse plus activity scope", async () => {
    const invalid = await client.callTool({
      name: "estimate_cycling_threshold",
      arguments: { start_date: "2026-08-02", end_date: "2026-08-01" },
    });
    expect(invalid.isError).toBe(true);
    expect(mocks.estimate).not.toHaveBeenCalled();

    const unavailableServer = new McpServer({ name: "unavailable", version: "1.0.0" });
    registerCyclingThresholdEstimateTool(unavailableServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    const unavailableClient = new Client({ name: "unavailable-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await unavailableServer.connect(serverTransport);
    await unavailableClient.connect(clientTransport);
    const unavailable = await unavailableClient.callTool({
      name: "estimate_cycling_threshold",
      arguments: { start_date: "2026-05-01", end_date: "2026-08-01" },
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("ClickHouse analytics store") }),
    ]);
    await unavailableClient.close();
    await unavailableServer.close();

    const deniedServer = new McpServer({ name: "denied", version: "1.0.0" });
    registerCyclingThresholdEstimateTool(deniedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      scopes: ["health:read"],
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    const deniedClient = new Client({ name: "denied-client", version: "1.0.0" });
    const [deniedClientTransport, deniedServerTransport] = InMemoryTransport.createLinkedPair();
    await deniedServer.connect(deniedServerTransport);
    await deniedClient.connect(deniedClientTransport);
    const denied = await deniedClient.callTool({
      name: "estimate_cycling_threshold",
      arguments: { start_date: "2026-05-01", end_date: "2026-08-01" },
    });
    expect(denied.isError).toBe(true);
    expect(mocks.estimate).not.toHaveBeenCalled();
    await deniedClient.close();
    await deniedServer.close();
  });
});
