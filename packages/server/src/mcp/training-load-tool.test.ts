import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticalTrainingLoadOutputSchema } from "./analytical-training-load-output.ts";
import { trainingLoadOutputSchema } from "./tool-output.ts";

const mocks = vi.hoisted(() => ({ analyticalListRange: vi.fn(), legacyListRange: vi.fn() }));

vi.mock("../repositories/analytical-training-load-repository.ts", () => ({
  AnalyticalTrainingLoadRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.analyticalListRange };
  }),
}));

vi.mock("../repositories/training-load-repository.ts", () => ({
  TrainingLoadRepository: vi.fn(function vitestConstructor() {
    return { listRange: mocks.legacyListRange };
  }),
}));

import { registerTrainingLoadTool } from "./training-load-tool.ts";

const legacyRows = [
  {
    date: "2026-06-15",
    daily_load: 75,
    acute_load_7d: 420,
    chronic_load_28d: 350,
    workload_ratio: 1.2,
    coverage: { acute_window_days: 7, chronic_window_days: 28 },
  },
];

function analyticalResult() {
  const channel = (unit: string) => ({
    daily_value: 100,
    unit,
    value_kind: "calculated" as const,
    status: "available" as const,
    reason: null,
    source_activity_ids: ["00000000-0000-4000-8000-000000000010"],
    source_providers: ["wahoo"],
    coverage: {
      contributing_records: 1,
      supported_records: 1,
      first_observed_date: "2026-06-01",
    },
    context: { activities: 1 },
    rolling: {
      acute_7d_sum: null,
      chronic_28d_weekly_equivalent: null,
      workload_ratio: null,
      monotony_7d: null,
      strain_7d: null,
      acute_coverage_days: 1,
      chronic_coverage_days: 1,
      unavailable_reasons: ["Seven complete daily values are required for acute load."],
    },
  });
  return {
    range: { start_date: "2026-06-15", end_date: "2026-06-15", timezone: "UTC" },
    definitions: {
      cycling_power_tss: "Cycling definition",
      heart_rate_zone_load: "HR definition",
      session_rpe: "RPE definition",
      climbing_attempts: "Climbing definition",
      finger_load: "Finger definition",
      strength_volume: "Strength definition",
      rolling: "Rolling definition",
      monotony_strain: "Monotony definition",
    },
    total_daily_load: {
      value: null,
      reason:
        "Modality-specific loads use different units and are not treated as biologically interchangeable.",
    },
    rows: [
      {
        date: "2026-06-15",
        channels: {
          cycling_power_tss: channel("TSS points"),
          heart_rate_zone_load: channel("weighted zone-minutes"),
          session_rpe: channel("RPE-minutes"),
          climbing_attempts: channel("attempts"),
          finger_load: channel("kg-seconds"),
          strength_volume: channel("kg-reps"),
        },
      },
    ],
  };
}

describe("get_training_load", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    mocks.legacyListRange.mockReset().mockResolvedValue(legacyRows);
    mocks.analyticalListRange.mockReset().mockResolvedValue(analyticalResult());
    server = new McpServer({ name: "training-load-test", version: "1.0.0" });
    registerTrainingLoadTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["activity:read"],
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    client = new Client({ name: "training-load-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("preserves the legacy response exactly when detail is omitted", async () => {
    const result = await client.callTool({
      name: "get_training_load",
      arguments: { start_date: "2026-06-15", end_date: "2026-06-15" },
    });

    expect(mocks.legacyListRange).toHaveBeenCalledWith("2026-06-15", "2026-06-15");
    expect(mocks.analyticalListRange).not.toHaveBeenCalled();
    if (result.isError)
      throw new Error(result.content[0]?.type === "text" ? result.content[0].text : "Tool failed");
    expect(trainingLoadOutputSchema.parse(result.structuredContent)).toEqual({
      result: {
        range: { start_date: "2026-06-15", end_date: "2026-06-15", timezone: "UTC" },
        rows: legacyRows,
      },
    });
  });

  it("returns separate provenance-rich load channels when analytical detail is requested", async () => {
    const result = await client.callTool({
      name: "get_training_load",
      arguments: {
        start_date: "2026-06-15",
        end_date: "2026-06-15",
        detail: "analytical",
      },
    });

    expect(mocks.analyticalListRange).toHaveBeenCalledWith("2026-06-15", "2026-06-15");
    expect(mocks.legacyListRange).not.toHaveBeenCalled();
    if (result.isError)
      throw new Error(result.content[0]?.type === "text" ? result.content[0].text : "Tool failed");
    const parsed = analyticalTrainingLoadOutputSchema.parse(result.structuredContent);
    expect(parsed.result.total_daily_load.value).toBeNull();
    expect(parsed.result.rows[0]?.channels).toMatchObject({
      cycling_power_tss: { unit: "TSS points" },
      climbing_attempts: { unit: "attempts" },
      finger_load: { unit: "kg-seconds" },
    });
  });
});
