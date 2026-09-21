import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thresholdHistoryOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ listHistory: vi.fn() }));

vi.mock("../repositories/cycling-threshold-repository.ts", () => ({
  CyclingThresholdRepository: vi.fn(function vitestConstructor() {
    return { listHistory: mocks.listHistory };
  }),
}));

import { registerThresholdHistoryTool } from "./threshold-history-tool.ts";

const page = {
  start_date: "2026-05-01",
  end_date: "2026-08-01",
  items: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      evidence_kind: "configured" as const,
      sport: "cycling",
      threshold_type: "ftp",
      value: 250,
      unit: "watt",
      observed_at: "2026-07-01T12:00:00.000Z",
      effective_at: "2026-07-01T12:00:00.000Z",
      provider: null,
      provider_record_id: null,
      value_kind: "configured" as const,
      historical_validity: "effective_dated" as const,
      raw_evidence_available: false,
      quality: {
        status: "high" as const,
        reason: null,
      },
    },
  ],
  legacy_current: {
    value: 240,
    unit: "watt" as const,
    source: "user_profile.ftp" as const,
    value_kind: "configured" as const,
    historical_validity: "unknown" as const,
    reason: "Legacy current FTP has no effective date and is not applied to historical activities",
  },
  next_cursor: null,
};

describe("get_threshold_history", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.listHistory.mockReset().mockResolvedValue(page);
    server = new McpServer({ name: "threshold-history-test", version: "1.0.0" });
    registerThresholdHistoryTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      scopes: ["activity:read"],
      timezone: "America/Los_Angeles",
    });
    client = new Client({ name: "threshold-history-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("passes exact range, provider filters, and pagination and parses strict evidence", async () => {
    const result = await client.callTool({
      name: "get_threshold_history",
      arguments: {
        start_date: "2026-05-01",
        end_date: "2026-08-01",
        cursor: "next-page",
        limit: 250,
      },
    });

    expect(mocks.listHistory).toHaveBeenCalledWith({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: "next-page",
      limit: 250,
    });
    expect(
      thresholdHistoryOutputSchema.parse(result.structuredContent).result.items[0],
    ).toMatchObject({
      provider: null,
      value_kind: "configured",
      historical_validity: "effective_dated",
    });
    expect(
      thresholdHistoryOutputSchema.safeParse({ ...result.structuredContent, unexpected: true })
        .success,
    ).toBe(false);
  });

  it("uses compact defaults", async () => {
    await client.callTool({
      name: "get_threshold_history",
      arguments: { start_date: "2026-05-01", end_date: "2026-08-01" },
    });

    expect(mocks.listHistory).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: null, limit: 100 }),
    );
  });

  it("rejects reversed ranges before querying", async () => {
    const result = await client.callTool({
      name: "get_threshold_history",
      arguments: { start_date: "2026-08-02", end_date: "2026-08-01" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("start_date must be on or before") }),
    ]);
    expect(mocks.listHistory).not.toHaveBeenCalled();
  });

  it("requires activity read scope", async () => {
    const deniedServer = new McpServer({ name: "denied", version: "1.0.0" });
    registerThresholdHistoryTool(deniedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      scopes: ["health:read"],
      timezone: "UTC",
    });
    const deniedClient = new Client({ name: "denied-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await deniedServer.connect(serverTransport);
    await deniedClient.connect(clientTransport);
    const result = await deniedClient.callTool({
      name: "get_threshold_history",
      arguments: { start_date: "2026-05-01", end_date: "2026-08-01" },
    });
    expect(result.isError).toBe(true);
    expect(mocks.listHistory).not.toHaveBeenCalled();
    await deniedClient.close();
    await deniedServer.close();
  });
});
