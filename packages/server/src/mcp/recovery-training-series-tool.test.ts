import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryTrainingSeriesOutputSchema } from "./recovery-training-series-output.ts";

const mocks = vi.hoisted(() => ({ listRange: vi.fn() }));

vi.mock("../repositories/recovery-training-series-repository.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../repositories/recovery-training-series-repository.ts")>();
  return {
    ...original,
    RecoveryTrainingSeriesRepository: vi.fn(function vitestConstructor() {
      return { listRange: mocks.listRange };
    }),
  };
});

import { registerRecoveryTrainingSeriesTool } from "./recovery-training-series-tool.ts";

describe("get_recovery_training_series", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.listRange.mockReset().mockResolvedValue({
      range: { start_date: "2026-03-08", end_date: "2026-03-09", timezone: "UTC" },
      requested_streams: ["health"],
      filters: { providers: [], modalities: [] },
      interpretation: {
        date_alignment: "Local calendar dates.",
        causality: "No causal claims.",
        filter_scope: "Filters apply to activity-derived streams.",
      },
      rows: [
        {
          date: "2026-03-08",
          health: {
            hrv: {
              value: 52,
              status: "observed",
              value_kind: "provider_supplied",
              source_providers: ["apple_health"],
              provenance_scope: "daily_row",
            },
            resting_hr: {
              value: null,
              status: "missing",
              value_kind: "calculated_from_deduped_samples",
              source_providers: [],
              provenance_scope: "deduped_resting_hr_series",
            },
            respiratory_rate: {
              value: 14,
              status: "observed",
              value_kind: "provider_supplied",
              source_providers: ["apple_health"],
              provenance_scope: "daily_row",
            },
            steps: {
              value: 8000,
              status: "observed",
              value_kind: "provider_supplied",
              source_providers: ["apple_health"],
              provenance_scope: "daily_row",
            },
          },
        },
      ],
    });
    server = new McpServer({ name: "recovery-series-test", version: "1.0.0" });
    registerRecoveryTrainingSeriesTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["health:read", "nutrition:read"],
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    client = new Client({ name: "recovery-series-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("returns only the requested compact streams", async () => {
    const result = await client.callTool({
      name: "get_recovery_training_series",
      arguments: {
        start_date: "2026-03-08",
        end_date: "2026-03-09",
        streams: ["health"],
      },
    });

    if (result.isError)
      throw new Error(result.content[0]?.type === "text" ? result.content[0].text : "Tool failed");
    expect(recoveryTrainingSeriesOutputSchema.parse(result.structuredContent).result.rows).toEqual([
      expect.objectContaining({ date: "2026-03-08", health: expect.any(Object) }),
    ]);
    expect(mocks.listRange).toHaveBeenCalledWith("2026-03-08", "2026-03-09", ["health"], {
      providers: [],
      modalities: [],
    });
  });

  it("bounds dense responses to 366 days", async () => {
    const result = await client.callTool({
      name: "get_recovery_training_series",
      arguments: { start_date: "2025-01-01", end_date: "2026-01-02" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("at most 366 inclusive days");
    }
    expect(mocks.listRange).not.toHaveBeenCalled();
  });

  it.each([
    { stream: "nutrition" as const, scope: "nutrition:read" as const },
    { stream: "subjective" as const, scope: "health:read" as const },
    { stream: "activities" as const, scope: "activity:read" as const },
  ])(
    "allows a $stream-only request with only $scope and no ClickHouse",
    async ({ stream, scope }) => {
      const scopedServer = new McpServer({ name: `${stream}-series-test`, version: "1.0.0" });
      registerRecoveryTrainingSeriesTool(scopedServer, {
        db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000002",
        scopes: [scope],
        timezone: "UTC",
      });
      const scopedClient = new Client({ name: `${stream}-series-client`, version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await scopedServer.connect(serverTransport);
      await scopedClient.connect(clientTransport);
      mocks.listRange.mockResolvedValueOnce({
        range: { start_date: "2026-03-08", end_date: "2026-03-08", timezone: "UTC" },
        requested_streams: [stream],
        filters: { providers: [], modalities: [] },
        interpretation: {
          date_alignment: "Local calendar dates.",
          causality: "No causal claims.",
          filter_scope: "Filters apply to activity-derived streams.",
        },
        rows: [{ date: "2026-03-08" }],
      });

      try {
        const result = await scopedClient.callTool({
          name: "get_recovery_training_series",
          arguments: {
            start_date: "2026-03-08",
            end_date: "2026-03-08",
            streams: [stream],
          },
        });
        expect(result.isError).not.toBe(true);
      } finally {
        await scopedClient.close();
        await scopedServer.close();
      }
    },
  );
});
