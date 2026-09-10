import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingPowerCurveRepository } from "../repositories/cycling-power-curve-repository.ts";
import {
  CYCLING_THRESHOLD_METHODS,
  CyclingThresholdEstimator,
} from "../repositories/cycling-threshold-estimator.ts";
import { CyclingThresholdRepository } from "../repositories/cycling-threshold-repository.ts";
import { NearbyWeightRepository } from "../repositories/nearby-weight-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { cyclingThresholdEstimateOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register explicitly labeled configured and modeled cycling threshold methods. */
export function registerCyclingThresholdEstimateTool(
  server: McpServer,
  context: DofekMcpContext,
): void {
  server.registerTool(
    "estimate_cycling_threshold",
    {
      title: "Estimate Cycling Threshold",
      description:
        "Return the best-supported or selected cycling threshold method with uncertainty, assumptions, source efforts, activity IDs, and nearby body-weight provenance. Calculated values are never labeled measured FTP.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        method: z.enum(CYCLING_THRESHOLD_METHODS).optional(),
        modalities: z.array(z.string().min(1)).max(20).optional(),
        providers: z.array(z.string().min(1)).max(50).optional(),
      },
      outputSchema: cyclingThresholdEstimateOutputSchema,
    },
    async ({ start_date, end_date, method, modalities, providers }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("estimate_cycling_threshold requires the ClickHouse analytics store");
      }
      const estimator = new CyclingThresholdEstimator({
        powerCurve: new CyclingPowerCurveRepository(
          context.sensorStore,
          context.userId,
          context.timezone,
        ),
        thresholds: new CyclingThresholdRepository(context.db, context.userId, context.timezone),
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
          method: method ?? "best_supported",
          modalities: modalities ?? [],
          providers: providers ?? [],
        }),
      );
    },
  );
}
