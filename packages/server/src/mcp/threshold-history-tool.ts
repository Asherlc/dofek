import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingThresholdRepository } from "../repositories/cycling-threshold-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { thresholdHistoryOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register effective-dated cycling threshold configuration. */
export function registerThresholdHistoryTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_threshold_history",
    {
      title: "Get Threshold History",
      description:
        "Return effective-dated cycling FTP configuration and separately labeled legacy current FTP.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: thresholdHistoryOutputSchema,
    },
    async ({ start_date, end_date, cursor, limit }) => {
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
          cursor: cursor ?? null,
          limit: limit ?? 100,
        }),
      );
    },
  );
}
