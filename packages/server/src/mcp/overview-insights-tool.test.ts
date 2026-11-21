import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Insight } from "../insights/types.ts";
import type { DofekMcpContext } from "./context.ts";
import { overviewInsightsOutputSchema } from "./overview-insights-output.ts";
import type { McpScope } from "./token-repository.ts";

const mocks = vi.hoisted(() => {
  const repositoryArgs: unknown[][] = [];
  return { computeInsights: vi.fn(), repositoryArgs };
});

vi.mock("../repositories/insights-repository.ts", () => ({
  InsightsRepository: vi.fn(function vitestConstructor(...args: unknown[]) {
    mocks.repositoryArgs.push(args);
    return { computeInsights: mocks.computeInsights };
  }),
}));

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

import { registerOverviewInsightsTool } from "./overview-insights-tool.ts";

const userId = "00000000-0000-4000-8000-000000000002";
const allScopes: McpScope[] = ["health:read", "activity:read", "nutrition:read"];

function insight(
  overrides: Partial<Insight> & Pick<Insight, "id" | "type" | "confidence">,
): Insight {
  return {
    metric: "hrv",
    action: "slept 7+ hours",
    message: "Observed association: hrv is higher on days with slept 7+ hours",
    detail: "slept 7+ hours: avg 60.0 vs 50.0 without (n=20/15)",
    whenTrue: { mean: 60, median: 60, stddev: 4, p25: 57, p75: 63, n: 20 },
    whenFalse: { mean: 50, median: 50, stddev: 4, p25: 47, p75: 53, n: 15 },
    effectSize: 0.9,
    pValue: 0.004,
    dataPoints: [{ x: 1, y: 2, date: "2026-06-01" }],
    distributions: { withAction: [60], withoutAction: [50] },
    ...overrides,
  };
}

function context(overrides: Partial<DofekMcpContext> = {}): DofekMcpContext {
  return {
    db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
    userId,
    clientId: "test-client",
    scopes: allScopes,
    timezone: "UTC",
    sensorStore: { query: vi.fn() },
    ...overrides,
  };
}

describe("get_overview_insights", () => {
  let client: Client;
  let server: McpServer;

  async function connect(mcpContext: DofekMcpContext) {
    server = new McpServer({ name: "overview-insights-test", version: "1.0.0" });
    registerOverviewInsightsTool(server, mcpContext);
    client = new Client({ name: "overview-insights-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  beforeEach(async () => {
    mocks.computeInsights.mockReset().mockResolvedValue([]);
    mocks.repositoryArgs.length = 0;
    await connect(context());
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists a read-only tool that declares all three read scopes", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((candidate) => candidate.name === "get_overview_insights");

    expect(tool).toMatchObject({
      title: "Get Overview Insights",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      _meta: {
        securitySchemes: [
          { type: "oauth2", scopes: ["health:read", "activity:read", "nutrition:read"] },
        ],
      },
    });
    expect(tool?.outputSchema).toMatchObject({ type: "object" });
    expect(tool?.description).toContain("causation");
  });

  it("returns structured summaries in computation order without raw points", async () => {
    const strong = insight({ id: "sleep-hrv", type: "conditional", confidence: "strong" });
    const insufficient = insight({
      id: "monthly-weight",
      type: "discovery",
      confidence: "insufficient",
      action: "calories",
      metric: "weight_kg",
    });
    const correlation = insight({
      id: "steps-hrv",
      type: "correlation",
      confidence: "emerging",
      action: "steps",
      metric: "hrv",
      correlation: { rho: 0.42, pValue: 0.01, n: 30 },
      evidence: {
        relationship: "correlation",
        label: "Descriptive correlation",
        method: "Spearman rank correlation over paired observations.",
        observationWindow: "Daily observations",
      },
    });
    mocks.computeInsights.mockResolvedValue([strong, insufficient, correlation]);

    const result = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15" },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));

    const parsed = overviewInsightsOutputSchema.parse(result.structuredContent);
    expect(parsed.result.range).toEqual({
      start_date: "2026-03-18",
      end_date: "2026-06-15",
      timezone: "UTC",
      days: 90,
    });
    expect(parsed.result.insights.map((item) => [item.id, item.confidence])).toEqual([
      ["sleep-hrv", "strong"],
      ["monthly-weight", "insufficient"],
      ["steps-hrv", "emerging"],
    ]);
    expect(parsed.result.insights[2]).toMatchObject({
      effect_size: 0.9,
      p_value: 0.004,
      correlation: { rho: 0.42, p_value: 0.01, n: 30 },
      evidence: { relationship: "correlation" },
    });
    const serialized = JSON.stringify(parsed.result.insights);
    expect(serialized).not.toContain("dataPoints");
    expect(serialized).not.toContain("data_points");
    expect(serialized).not.toContain("distributions");
    expect(serialized).not.toContain("whenTrue");
    expect(serialized).not.toContain("when_true");
  });

  it("returns the requested range with an empty insight list when nothing qualifies", async () => {
    mocks.computeInsights.mockResolvedValue([]);

    const result = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15" },
    });
    if (result.isError) throw new Error(JSON.stringify(result.content));

    expect(overviewInsightsOutputSchema.parse(result.structuredContent)).toEqual({
      result: {
        range: {
          start_date: "2026-03-18",
          end_date: "2026-06-15",
          timezone: "UTC",
          days: 90,
        },
        insights: [],
      },
    });
  });

  it("forwards the authenticated user, explicit timezone, and fixed 90-day window", async () => {
    await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15", timezone: "America/New_York" },
    });

    expect(mocks.repositoryArgs).toEqual([
      [expect.anything(), userId, "America/New_York", expect.anything()],
    ]);
    expect(mocks.computeInsights).toHaveBeenCalledWith(90, "2026-06-15");
  });

  it("defaults the timezone to the MCP context when none is supplied", async () => {
    await client.close();
    await server.close();
    await connect(context({ timezone: "America/Los_Angeles" }));

    await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15" },
    });

    expect(mocks.repositoryArgs).toEqual([
      [expect.anything(), userId, "America/Los_Angeles", expect.anything()],
    ]);
  });

  it("rejects an invalid end date and a non-IANA timezone before computing", async () => {
    const badDate = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "06/15/2026" },
    });
    const badZone = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15", timezone: "Not/AZone" },
    });
    const offsetZone = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15", timezone: "+02:00" },
    });

    expect(badDate.isError).toBe(true);
    expect(badZone.isError).toBe(true);
    expect(offsetZone.isError).toBe(true);
    expect(mocks.computeInsights).not.toHaveBeenCalled();
    expect(mocks.repositoryArgs).toEqual([]);
  });

  it.each(allScopes)("denies the call when the %s scope is missing", async (missing) => {
    await client.close();
    await server.close();
    await connect(context({ scopes: allScopes.filter((scope) => scope !== missing) }));

    const result = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15" },
    });

    expect(result.isError).toBe(true);
    expect(mocks.computeInsights).not.toHaveBeenCalled();
    expect(mocks.repositoryArgs).toEqual([]);
  });

  it("errors when the analytics store is unavailable", async () => {
    await client.close();
    await server.close();
    await connect(context({ sensorStore: undefined }));

    const result = await client.callTool({
      name: "get_overview_insights",
      arguments: { end_date: "2026-06-15" },
    });

    expect(result.isError).toBe(true);
    expect(mocks.computeInsights).not.toHaveBeenCalled();
    expect(mocks.repositoryArgs).toEqual([]);
  });
});
