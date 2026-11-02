import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cyclingThresholdUncertainty } from "../contracts/cycling-threshold.ts";
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
    result: {
      threshold_watts: 285,
      watts_per_kg: null,
      watts_per_kg_reason: "No directly measured body weight within 30 days",
      method: "computed_eftp" as const,
      classification: "estimated" as const,
      uncertainty: cyclingThresholdUncertainty,
      evidence: {
        value: 285,
        unit: "watt",
        method: "computed_eftp",
        event_at: "2026-08-01T00:00:00Z",
        evidence_activity_id: null,
        evidence_at: null,
        evidence_duration_seconds: null,
        evidence_power: null,
        model_version: "v1",
        uncertainty: {
          kind: "not_quantifiable" as const,
          watts: null,
          reason:
            "Reference-curve estimate; individual physiological FTP uncertainty has not been quantified.",
        },
        unavailable_reason: null,
      },
      relevant_activity_ids: [],
      assumptions: ["FTP is an ongoing reference-curve estimate"],
    },
    unavailable_reason: null,
    weight: {
      value_kg: null as const,
      reason: "No directly measured body weight within 30 days",
    },
  };
}

it.each([0, -1])("rejects zero or negative threshold watts per kilogram %s", (watts_per_kg) => {
  const payload = response();
  expect(
    cyclingThresholdEstimateOutputSchema.safeParse({
      ...payload,
      result: { ...payload.result, watts_per_kg },
    }).success,
  ).toBe(false);
});

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

  it("passes the requested end date and strictly parses computed evidence", async () => {
    const result = await client.callTool({
      name: "estimate_cycling_threshold",
      arguments: {
        start_date: "2026-05-01",
        end_date: "2026-08-01",
      },
    });

    expect(mocks.estimate).toHaveBeenCalledWith({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
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
