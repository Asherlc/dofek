import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { AnalyticalTrainingLoadRepository } from "../repositories/analytical-training-load-repository.ts";
import { TrainingLoadRepository } from "../repositories/training-load-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { trainingLoadToolOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";

/** Register the activity-load analytics tool. */
export function registerTrainingLoadTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_training_load",
    {
      title: "Get Training Load",
      description:
        "Return daily training load with rolling windows. Set detail=analytical for separate cycling-power, heart-rate, session-RPE, climbing, finger, and strength channels with formulas, provenance, and missing-data coverage.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        detail: z.enum(["analytical"]).optional(),
      },
      outputSchema: trainingLoadToolOutputSchema,
    },
    async ({ start_date, end_date, detail }) => {
      requireMcpScope(context.scopes, "activity:read");
      if (start_date > end_date) {
        throw new Error("start_date must be on or before end_date");
      }
      if (!context.sensorStore) {
        throw new Error("get_training_load requires the ClickHouse analytics store");
      }
      if (detail === "analytical") {
        return jsonToolResult(
          await new AnalyticalTrainingLoadRepository(
            context.db,
            context.sensorStore,
            context.userId,
            context.timezone,
          ).listRange(start_date, end_date),
        );
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
