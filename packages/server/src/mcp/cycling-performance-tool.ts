import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingPerformanceRepository } from "../repositories/cycling-performance-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { cyclingPerformanceOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";

/** Register exact-range, load-normalized cycling analytics. */
export function registerCyclingPerformanceTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_cycling_performance",
    {
      title: "Get Cycling Performance",
      description:
        "Return per-ride normalized power, intensity factor, 5s/1m/5m/20m best efforts, rolling-90-day bests, estimated FTP, elevation gain, selected-range coverage, and all-history power availability by modality.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: { start_date: dateSchema, end_date: dateSchema },
      outputSchema: cyclingPerformanceOutputSchema,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "activity:read");
      if (start_date > end_date) throw new Error("start_date must be on or before end_date");
      if (!context.sensorStore) {
        throw new Error("get_cycling_performance requires the ClickHouse analytics store");
      }
      return jsonToolResult({
        range: { start_date, end_date, timezone: context.timezone },
        ...(await new CyclingPerformanceRepository(
          context.sensorStore,
          context.userId,
          context.timezone,
        ).listRange(start_date, end_date)),
      });
    },
  );
}
