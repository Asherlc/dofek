import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SupplementsRepository } from "../repositories/supplements-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolOutputSchema } from "./tool-output.ts";
import { jsonContent } from "./tool-utils.ts";

/** Register the authenticated user's current supplement definitions. */
export function registerSupplementsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_supplements",
    {
      title: "Get Supplements",
      description: "Return the authenticated user's current supplement definitions and nutrients.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {},
      outputSchema: jsonToolOutputSchema,
    },
    async () => {
      requireMcpScope(context.scopes, "nutrition:read");
      return jsonContent(
        await new SupplementsRepository(context.db, context.userId, context.timezone).list(),
      );
    },
  );
}
