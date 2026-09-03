import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SupplementsRepository } from "../repositories/supplements-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { supplementsOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";

/** Register the authenticated user's current supplement definitions. */
export function registerSupplementsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_supplements",
    {
      title: "Get Supplements",
      description: "Return the authenticated user's current supplement definitions and nutrients.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {},
      outputSchema: supplementsOutputSchema,
    },
    async () => {
      requireMcpScope(context.scopes, "nutrition:read");
      return jsonToolResult(
        await new SupplementsRepository(context.db, context.userId, context.timezone).list(),
      );
    },
  );
}
