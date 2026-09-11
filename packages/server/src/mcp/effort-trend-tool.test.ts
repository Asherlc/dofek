import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effortTrendOutputSchema } from "./effort-trend-output.ts";
import { registerEffortTrendTool } from "./effort-trend-tool.ts";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../repositories/effort-trend-repository.ts", () => ({
  EffortTrendRepository: class {
    get = mocks.get;
  },
}));

describe("get_effort_trend", () => {
  let server: McpServer;
  let client: Client;
  const scopes: Array<"activity:read"> = [];

  beforeEach(async () => {
    scopes.splice(0, scopes.length, "activity:read");
    mocks.get.mockReset().mockResolvedValue({
      equivalence: {
        key: { kind: "provider_workout", provider: "zwift", value: "17" },
        identity: { kind: "provider_workout", namespace: "zwift", value: "17" },
        strength: "exact",
        basis: "explicit",
        method: "explicit_identity",
        confidence: "high",
        assumptions: [],
      },
      repetitions: [],
      definitions: {
        deltas: "Every numeric delta is current minus the named comparison repetition.",
        rolling: "Rolling values are descriptive means, not physiological claims.",
        best: "Best values are descriptive.",
      },
      quality: { comparable_repetitions: 0, total_repetitions: 0 },
      evidence: [],
      assumptions: ["Identity does not establish maximal intent."],
      caveats: [
        "Ordinary workout bests are lower-bound observed capability, not maximal capacity.",
      ],
    });
    server = new McpServer({ name: "test", version: "1" });
    registerEffortTrendTool(server, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      sensorStore: { query: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      timezone: "UTC",
      scopes,
    });
    client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  const call = (args = {}) => ({
    name: "get_effort_trend",
    arguments: { start_date: "2026-01-01", end_date: "2026-12-31", ...args },
  });

  it("requires exactly one discovery effort ID or equivalence specification", async () => {
    expect(await client.callTool(call())).toMatchObject({ isError: true });
    expect(
      await client.callTool(
        call({
          effort_id: "provider_workout:zwift:17",
          equivalence: { kind: "canonical_route", value: "r1" },
        }),
      ),
    ).toMatchObject({ isError: true });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("validates input, scope, and its strict result schema", async () => {
    const result = await client.callTool(call({ effort_id: "provider_workout:zwift:17" }));
    expect(result.isError).not.toBe(true);
    expect(effortTrendOutputSchema.parse(result.structuredContent).result.repetitions).toEqual([]);
    expect(mocks.get).toHaveBeenCalledWith({
      effortId: "provider_workout:zwift:17",
      equivalence: undefined,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    mocks.get.mockClear();
    expect(
      await client.callTool(
        call({ effort_id: "provider_workout:zwift:17", end_date: "2025-01-01" }),
      ),
    ).toMatchObject({
      isError: true,
    });
    scopes.length = 0;
    expect(await client.callTool(call({ effort_id: "provider_workout:zwift:17" }))).toMatchObject({
      isError: true,
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
