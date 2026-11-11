import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingThresholdEstimator } from "../repositories/cycling-threshold-estimator.ts";
import { CyclingThresholdRepository } from "../repositories/cycling-threshold-repository.ts";
import { NearbyWeightRepository } from "../repositories/nearby-weight-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { cyclingThresholdEstimateOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Present the canonical ongoing cycling threshold and its evidence. */
export function registerCyclingThresholdEstimateTool(
  server: McpServer,
  context: DofekMcpContext,
): void {
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "estimate_cycling_threshold",
    {
      title: "Estimate Cycling Threshold",
      description:
        "Return the canonical ongoing computed cycling eFTP as of the end date, with reference-effort evidence, uncertainty limitations and nearby measured body weight. Earlier evidence remains applicable regardless of the displayed date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
      }),
      outputSchema: cyclingThresholdEstimateOutputSchema,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("estimate_cycling_threshold requires the ClickHouse analytics store");
      }
      const estimator = new CyclingThresholdEstimator({
        thresholds: new CyclingThresholdRepository(
          context.sensorStore,
          context.userId,
          context.timezone,
        ),
        nearbyWeight: new NearbyWeightRepository(
          context.sensorStore,
          context.userId,
          context.timezone,
        ),
      });
      return jsonToolResult(
        await estimator.estimate({
          startDate: start_date,
          endDate: end_date,
        }),
      );
    },
  );
}
