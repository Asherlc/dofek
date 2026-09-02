import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SupplementsRepository } from "../repositories/supplements-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";

/** Register the authenticated user's current supplement definitions. */
export function registerSupplementsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_supplements",
    {
      title: "Get Supplements",
      description: "Return the authenticated user's current supplement definitions and nutrients.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      requireMcpScope(context.scopes, "nutrition:read");
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              await new SupplementsRepository(context.db, context.userId, context.timezone).list(),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
