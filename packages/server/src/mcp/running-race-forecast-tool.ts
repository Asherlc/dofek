import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { localDateString } from "../repositories/resting-heart-rate-query.ts";
import {
  readRunningRaceForecastSource,
  runningRaceForecastSourceSchema,
} from "../repositories/running-race-forecast-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const targetSchema = z.enum(["10k", "half_marathon"]);
const targetMeters = { "10k": 10000, half_marathon: 21097.5 };
const method = {
  name: "Riegel",
  exponent: 1.07,
  citation_url: "https://doi.org/10.1186/s13102-016-0052-y",
} as const;
const targetOutput = {
  target: targetSchema,
  target_distance_meters: z.number().positive(),
};
const outputSchema = z.object({
  result: z.discriminatedUnion("status", [
    z.object({
      ...targetOutput,
      status: z.literal("estimated"),
      estimated_finish_seconds: z.number().positive(),
      method: z.object({
        name: z.literal(method.name),
        exponent: z.literal(method.exponent),
        citation_url: z.literal(method.citation_url),
      }),
      source: runningRaceForecastSourceSchema,
    }),
    z.object({
      ...targetOutput,
      status: z.literal("unavailable"),
      reason: z.literal("no_eligible_race_result"),
    }),
  ]),
});

export function registerRunningRaceForecastTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_running_race_forecast",
    {
      title: "Get Running Race Forecast",
      description:
        "Estimate a 10K or half-marathon finish from an eligible, shorter recorded race within the inclusive local race date range, with method and source evidence.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({ start_date: dateSchema, end_date: dateSchema, target: targetSchema }),
      outputSchema,
    },
    async ({ start_date, end_date, target }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      const distance = targetMeters[target];
      const today = localDateString(new Date(), context.timezone);
      const source = await readRunningRaceForecastSource(context.db, context.userId, {
        startDate: start_date,
        endDate: end_date < today ? end_date : today,
        targetMeters: distance,
      });
      const resultBase = { target, target_distance_meters: distance };
      if (!source) {
        return jsonToolResult({
          ...resultBase,
          status: "unavailable",
          reason: "no_eligible_race_result",
        });
      }
      return jsonToolResult({
        ...resultBase,
        status: "estimated",
        estimated_finish_seconds:
          source.finish_seconds * (distance / source.distance_meters) ** method.exponent,
        method,
        source,
      });
    },
  );
}
