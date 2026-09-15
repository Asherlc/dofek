import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "drizzle-orm";
import type express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createApp } from "../index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import {
  foodRecordMutationOutputSchema,
  foodRecordSearchOutputSchema,
} from "./food-record-output.ts";
import { createMcpToken } from "./token-repository.ts";

const insertedUserRowSchema = z.object({ id: z.string() });

function serverPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("MCP test server has no address");
  }
  return (address satisfies AddressInfo).port;
}

describe("MCP SDK write and fresh discovery", () => {
  let context: TestContext;
  let server: ReturnType<express.Express["listen"]>;
  let endpoint: URL;
  let token: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    const rows = await executeWithSchema(
      context.db,
      insertedUserRowSchema,
      sql`INSERT INTO fitness.user_profile (name, email)
          VALUES ('MCP SDK Test User', 'mcp-sdk-write@test.com')
          RETURNING id`,
    );
    const userId = rows[0]?.id;
    if (!userId) throw new Error("Failed to create MCP SDK test user");

    ({ token } = await createMcpToken(context.db, {
      userId,
      name: "MCP SDK write regression",
      scopes: ["nutrition:read", "nutrition:write"],
      expiresAt: null,
    }));

    const app = createApp(context.db, makeMockSensorStore(), { mcpAuthRateLimit: false });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    endpoint = new URL(`http://127.0.0.1:${serverPort(server)}/api/mcp`);
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await context?.cleanup();
  });

  it("writes through SDK HTTP, validates the result, then rediscovers and reads it", async () => {
    const firstClient = new Client({ name: "dofek-sdk-write-test", version: "1.0.0" });
    let firstClientClosed = false;
    const firstTransport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      await firstClient.connect(firstTransport);
      const listed = await firstClient.listTools();
      expect(listed.nextCursor).toBeUndefined();
      expect(listed.tools).toHaveLength(41);
      const initialToolNames = listed.tools.map((tool) => tool.name).toSorted();
      const createTool = listed.tools.find((tool) => tool.name === "create_food_entry");
      expect(createTool).toBeDefined();
      expect(createTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(createTool?.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["request_id", "date", "food_name", "nutrients"]),
      });
      expect(createTool?.outputSchema).toMatchObject({
        type: "object",
        properties: { result: expect.objectContaining({ type: "object" }) },
      });

      const requestId = "11111111-1111-4111-8111-111111111111";
      const created = await firstClient.callTool({
        name: "create_food_entry",
        arguments: {
          request_id: requestId,
          date: "2026-09-15",
          meal: "breakfast",
          food_name: "SDK isolated oats",
          nutrients: { protein: 12.5 },
        },
      });
      expect(created.isError).not.toBe(true);
      const createdText = z
        .object({ type: z.literal("text"), text: z.string() })
        .parse(created.content[0]);
      const createdJson = JSON.parse(createdText.text);
      const createdStructured = z
        .object({ result: z.unknown() })
        .parse(created.structuredContent).result;
      expect(createdJson).toEqual(createdStructured);
      const mutation = foodRecordMutationOutputSchema.parse(created.structuredContent);
      expect(mutation.result.record.food_name).toBe("SDK isolated oats");
      expect(mutation.result.record.nutrients).toMatchObject({ protein: 12.5 });
      expect(mutation.result.operation.replayed).toBe(false);

      await firstClient.close();
      firstClientClosed = true;

      const freshClient = new Client({ name: "dofek-sdk-rediscovery-test", version: "1.0.0" });
      const freshTransport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      try {
        await freshClient.connect(freshTransport);
        const freshTools = await freshClient.listTools();
        expect(freshTools.nextCursor).toBeUndefined();
        expect(freshTools.tools).toHaveLength(41);
        expect(freshTools.tools.map((tool) => tool.name).toSorted()).toEqual(initialToolNames);
        expect(
          freshTools.tools.find((tool) => tool.name === "search_food_entries")?.annotations,
        ).toMatchObject({
          readOnlyHint: true,
          openWorldHint: false,
        });
        expect(
          freshTools.tools.find((tool) => tool.name === "search_food_entries")?.outputSchema,
        ).toMatchObject({
          type: "object",
          properties: { result: expect.objectContaining({ type: "object" }) },
        });

        const search = await freshClient.callTool({
          name: "search_food_entries",
          arguments: {
            start_date: "2026-09-15",
            end_date: "2026-09-15",
            query: "SDK isolated oats",
          },
        });
        expect(search.isError).not.toBe(true);
        const searchText = z
          .object({ type: z.literal("text"), text: z.string() })
          .parse(search.content[0]);
        const searchJson = JSON.parse(searchText.text);
        const searchStructured = z
          .object({ result: z.unknown() })
          .parse(search.structuredContent).result;
        expect(searchJson).toEqual(searchStructured);
        const result = foodRecordSearchOutputSchema.parse(search.structuredContent);
        expect(result.result.items).toHaveLength(1);
        expect(result.result.items[0]?.food_name).toBe("SDK isolated oats");
      } finally {
        await freshClient.close();
      }
    } finally {
      if (!firstClientClosed) await firstClient.close();
    }
  });
});
