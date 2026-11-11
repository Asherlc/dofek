import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { registerClimbingCatalogueTool } from "./climbing-catalogue-tool.ts";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../repositories/climbing-catalogue-repository.ts", () => ({
  ClimbingCatalogueRepository: class {
    read = read;
  },
}));
let client: Client;
let server: McpServer;
async function connect(scopes: Array<"activity:read"> = ["activity:read"]) {
  server = new McpServer({ name: "catalogue", version: "1.0.0" });
  registerClimbingCatalogueTool(server, {
    db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
    userId: "user-a",
    clientId: "client-a",
    timezone: "UTC",
    scopes,
  });
  client = new Client({ name: "catalogue-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.clearAllMocks();
});
it("advertises a cached-only read tool and returns the full context", async () => {
  const context = { status: "missing", fetchedAt: null, expiresAt: null, error: null, sources: [] };
  read.mockResolvedValue(context);
  await connect();
  const tools = await client.listTools();
  expect(
    tools.tools.find((tool) => tool.name === "get_climbing_catalogue_context")?.annotations,
  ).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  const id = "10000000-0000-4000-8000-000000000001";
  const result = await client.callTool({
    name: "get_climbing_catalogue_context",
    arguments: { climbing_log_entry_id: id },
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({ result: context });
  expect(read).toHaveBeenCalledWith(id);
});
it("requires the activity read scope before reading cache", async () => {
  await connect([]);
  const result = await client.callTool({
    name: "get_climbing_catalogue_context",
    arguments: { climbing_log_entry_id: "10000000-0000-4000-8000-000000000001" },
  });
  expect(result.isError).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
