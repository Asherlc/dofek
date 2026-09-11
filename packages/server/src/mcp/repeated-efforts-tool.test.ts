import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repeatedEffortsOutputSchema } from "./repeated-efforts-output.ts";
import { registerRepeatedEffortsTool } from "./repeated-efforts-tool.ts";

const mocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("../repositories/repeated-efforts-repository.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RepeatedEffortsRepository: class {
    find = mocks.find;
  },
}));

describe("find_repeated_efforts", () => {
  let server: McpServer;
  let client: Client;
  const scopes: Array<"activity:read"> = [];
  beforeEach(async () => {
    scopes.splice(0, scopes.length, "activity:read");
    mocks.find.mockReset().mockResolvedValue({
      groups: [],
      nextCursor: null,
      assumptions: ["Repeated efforts are not necessarily maximal tests."],
    });
    server = new McpServer({ name: "test", version: "1" });
    registerRepeatedEffortsTool(server, {
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
    name: "find_repeated_efforts",
    arguments: { start_date: "2026-01-01", end_date: "2026-12-31", ...args },
  });
  it("advertises evidence levels and returns a strict structured result with conservative defaults", async () => {
    const result = await client.callTool(call());
    expect(result.isError).not.toBe(true);
    expect(repeatedEffortsOutputSchema.parse(result.structuredContent).result.groups).toEqual([]);
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ minimumRepetitions: 2, equivalenceStrength: "strong", limit: 25 }),
    );
    const listed = await client.listTools();
    expect(listed.tools[0]?.description).toMatch(/Level A.*Level B.*Level C.*Level D/);
    expect(
      repeatedEffortsOutputSchema.safeParse({ ...result.structuredContent, surprise: true })
        .success,
    ).toBe(false);
  });
  it("passes explicit weak selection and filters", async () => {
    await client.callTool(
      call({
        equivalence_strength: "weak",
        effort_kind: "activity_name",
        providers: ["garmin"],
        modalities: ["outdoor"],
        canonical_types: ["running"],
        minimum_repetitions: 3,
        limit: 5,
        cursor: "next",
      }),
    );
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        equivalenceStrength: "weak",
        effortKind: "activity_name",
        providers: ["garmin"],
        modalities: ["outdoor"],
        canonicalTypes: ["running"],
        minimumRepetitions: 3,
        limit: 5,
        cursor: "next",
      }),
    );
  });
  it.each([
    { end_date: "2025-01-01" },
    { start_date: "2026-02-30" },
    { limit: 101 },
    { minimum_repetitions: 1 },
  ])("rejects invalid input %j before querying", async (args) => {
    expect(await client.callTool(call(args))).toMatchObject({ isError: true });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("requires activity:read before querying", async () => {
    scopes.length = 0;
    expect(await client.callTool(call())).toMatchObject({ isError: true });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("rejects malformed repository output", async () => {
    mocks.find.mockResolvedValue({
      groups: [{ strength: "exact" }],
      nextCursor: null,
      assumptions: [],
    });
    expect(await client.callTool(call())).toMatchObject({ isError: true });
  });
});
