import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { AnalyticalTrainingLoadRepository } from "../repositories/analytical-training-load-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { TrainingLoadRepository } from "../repositories/training-load-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import {
  assertNutritionSummaryDateRange,
  toNutritionSummaryOutput,
} from "./nutrition-summary-output.ts";
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
        "Return daily training load with rolling windows. Set detail=analytical for separate cycling-power, heart-rate, session-RPE, climbing, finger, and strength channels with formulas, provenance, and missing-data coverage. Set include_nutrition=true with analytical detail for an aligned nutrition date spine.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        detail: z.enum(["analytical"]).optional(),
        include_nutrition: z.boolean().optional(),
      },
      outputSchema: trainingLoadToolOutputSchema,
    },
    async ({ start_date, end_date, detail, include_nutrition }) => {
      requireMcpScope(context.scopes, "activity:read");
      if (start_date > end_date) {
        throw new Error("start_date must be on or before end_date");
      }
      if (include_nutrition && detail !== "analytical") {
        throw new Error("include_nutrition requires detail=analytical");
      }
      if (include_nutrition) {
        requireMcpScope(context.scopes, "nutrition:read");
        assertNutritionSummaryDateRange(start_date, end_date);
      }
      if (!context.sensorStore) {
        throw new Error("get_training_load requires the ClickHouse analytics store");
      }
      if (detail === "analytical") {
        const analyticalPromise = new AnalyticalTrainingLoadRepository(
          context.db,
          context.sensorStore,
          context.userId,
          context.timezone,
        ).listRange(start_date, end_date);
        if (!include_nutrition) return jsonToolResult(await analyticalPromise);
        const [analytical, nutrition] = await Promise.all([
          analyticalPromise,
          new FoodRepository(context.db, context.userId, context.timezone).dailyTotalsRange(
            start_date,
            end_date,
          ),
        ]);
        return jsonToolResult({
          ...analytical,
          nutrition: nutrition.map(toNutritionSummaryOutput),
        });
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
