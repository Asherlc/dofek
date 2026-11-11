import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingThresholdRepository } from "../repositories/cycling-threshold-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { thresholdHistoryOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register canonical computed cycling threshold history. */
export function registerThresholdHistoryTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_threshold_history",
    {
      title: "Get Threshold History",
      description:
        "Return ongoing computed cycling eFTP history, including supported effort evidence and modeled decay events.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      outputSchema: thresholdHistoryOutputSchema,
    },
    async ({ start_date, end_date, cursor, limit }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore)
        throw new Error("get_threshold_history requires the ClickHouse analytics store");
      return jsonToolResult(
        await new CyclingThresholdRepository(
          context.sensorStore,
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
