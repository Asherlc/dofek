import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dateSchema } from "../lib/date-schema.ts";
import { TrainingLoadRepository } from "../repositories/training-load-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { trainingLoadOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";

/** Register the activity-load analytics tool. */
export function registerTrainingLoadTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_training_load",
    {
      title: "Get Training Load",
      description:
        "Return daily training load, rolling 7-day acute load, rolling 28-day chronic load, and acute-to-chronic workload ratio with window coverage.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
      },
      outputSchema: trainingLoadOutputSchema,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "activity:read");
      if (start_date > end_date) {
        throw new Error("start_date must be on or before end_date");
      }
      if (!context.sensorStore) {
        throw new Error("get_training_load requires the ClickHouse analytics store");
      }
      return jsonToolResult({
        range: {
          start_date,
          end_date,
          timezone: context.timezone,
        },
        rows: await new TrainingLoadRepository(context.sensorStore, context.userId).listRange(
          start_date,
          end_date,
        ),
      });
    },
  );
}
