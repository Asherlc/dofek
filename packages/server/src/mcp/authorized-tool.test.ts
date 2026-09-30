import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { captureException } from "dofek/lib/error-reporting";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import { requireMcpScope } from "./token-repository.ts";

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

describe("registerAuthorizedTool", () => {
  let server: McpServer;
  let client: Client;
  beforeEach(() => {
    vi.clearAllMocks();
    server = new McpServer({ name: "authorization-test", version: "1" });
    client = new Client({ name: "authorization-client", version: "1" });
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });
  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }
  it("preserves tool UI metadata and passes authorized arguments and results through", async () => {
    const result = { content: [{ type: "text" as const, text: "Saved" }], _meta: { saved: true } };
    const callback = vi.fn(async ({ value }: { value: string }) => {
      requireMcpScope(["nutrition:write"], "nutrition:write");
      expect(value).toBe("food");
      return result;
    });
    registerAuthorizedTool(
      server,
      ["nutrition:write"],
      "save",
      {
        inputSchema: z.object({ value: z.string() }),
        _meta: { ui: { resourceUri: "ui://nutrition" } },
      },
      callback,
    );
    await connect();
    const tools = await client.listTools();
    expect(tools.tools[0]?._meta).toEqual({
      ui: { resourceUri: "ui://nutrition" },
      securitySchemes: [{ type: "oauth2", scopes: ["nutrition:write"] }],
    });
    expect(await client.callTool({ name: "save", arguments: { value: "food" } })).toMatchObject(
      result,
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(captureException).not.toHaveBeenCalled();
  });
  it("returns all required scopes in a nutrition consent challenge without running a write", async () => {
    const write = vi.fn();
    registerAuthorizedTool(
      server,
      ["nutrition:read", "nutrition:write"],
      "save",
      {
        inputSchema: z.object({}),
      },
      async () => {
        requireMcpScope(["nutrition:read"], "nutrition:write");
        write();
        return { content: [] };
      },
    );
    await connect();
    const result = await client.callTool({ name: "save", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "MCP token requires scope: nutrition:write" },
    ]);
    const challenges = z
      .object({ "mcp/www_authenticate": z.array(z.string()) })
      .parse(result._meta)["mcp/www_authenticate"];
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toContain('error="insufficient_scope"');
    expect(challenges[0]).toContain('scope="nutrition:read nutrition:write"');
    expect(challenges[0]).toContain(
      'error_description="MCP token requires scope: nutrition:write"',
    );
    expect(write).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
  it("reports unexpected failures instead of presenting them as consent errors", async () => {
    const error = new Error("Database unavailable");
    registerAuthorizedTool(
      server,
      ["nutrition:write"],
      "save",
      {
        inputSchema: z.object({}),
      },
      async () => {
        throw error;
      },
    );
    await connect();
    expect(await client.callTool({ name: "save", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Database unavailable" }],
    });
    expect(captureException).toHaveBeenCalledExactlyOnceWith(new Error("MCP tool save failed"));
  });
});
