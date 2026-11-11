import { climbingCatalogueContextSchema } from "@dofek/training/climbing-catalogue";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ClimbingCatalogueRepository } from "../repositories/climbing-catalogue-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";

export function registerClimbingCatalogueTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_climbing_catalogue_context",
    {
      title: "Get Climbing Catalogue Context",
      description:
        "Read cached reference information for an owned climbing log. Matches retain provider attribution and confidence. This tool does not fetch external catalogues, refresh the cache, or change recorded climbs or metrics.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({ climbing_log_entry_id: z.guid() }),
      outputSchema: z.object({ result: climbingCatalogueContextSchema }),
    },
    async ({ climbing_log_entry_id }) => {
      requireMcpScope(context.scopes, "activity:read");
      const repository = new ClimbingCatalogueRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
      );
      return jsonToolResult(await repository.read(climbing_log_entry_id));
    },
  );
}
