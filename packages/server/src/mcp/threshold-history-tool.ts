import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingThresholdRepository } from "../repositories/cycling-threshold-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { thresholdHistoryOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register effective-dated configuration and provider threshold evidence. */
export function registerThresholdHistoryTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_threshold_history",
    {
      title: "Get Threshold History",
      description:
        "Return effective-dated cycling FTP configuration, immutable provider observations, and separately labeled legacy current FTP. Provider-modeled values are never presented as measured FTP.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        providers: z.array(z.string().min(1)).max(50).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: thresholdHistoryOutputSchema,
    },
    async ({ start_date, end_date, providers, cursor, limit }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      return jsonToolResult(
        await new CyclingThresholdRepository(
          context.db,
          context.userId,
          context.timezone,
        ).listHistory({
          startDate: start_date,
          endDate: end_date,
          providers: providers ?? [],
          cursor: cursor ?? null,
          limit: limit ?? 100,
        }),
      );
    },
  );
}
