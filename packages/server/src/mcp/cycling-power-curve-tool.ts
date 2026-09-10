import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingPowerCurveRepository } from "../repositories/cycling-power-curve-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { cyclingPowerCurveOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const DEFAULT_DURATIONS_SECONDS = [
  1, 5, 15, 30, 60, 120, 300, 600, 720, 1200, 1800, 2400, 3600, 5400,
];
const durationSchema = z.number().int().min(1).max(21_600);

/** Register bounded, server-computed cycling power-duration analysis. */
export function registerCyclingPowerCurveTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_cycling_power_curve",
    {
      title: "Get Cycling Power Curve",
      description:
        "Return exact-range best rolling cycling power for standard or arbitrary durations, with activity offsets, source and sample-quality evidence, and W/kg only when supported by a nearby measured body weight.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        durations_seconds: z.array(durationSchema).min(1).max(32).optional(),
        modalities: z.array(z.string().min(1)).max(20).optional(),
        providers: z.array(z.string().min(1)).max(50).optional(),
        include_activity_curve: z.boolean().optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: cyclingPowerCurveOutputSchema,
    },
    async ({
      start_date,
      end_date,
      durations_seconds,
      modalities,
      providers,
      include_activity_curve,
      cursor,
      limit,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("get_cycling_power_curve requires the ClickHouse analytics store");
      }
      const requestedDurations = durations_seconds ?? DEFAULT_DURATIONS_SECONDS;
      if (new Set(requestedDurations).size !== requestedDurations.length) {
        throw new Error("durations must be unique");
      }
      const normalizedDurations = [...requestedDurations].sort((left, right) => left - right);
      return jsonToolResult(
        await new CyclingPowerCurveRepository(
          context.sensorStore,
          context.userId,
          context.timezone,
        ).listRange({
          startDate: start_date,
          endDate: end_date,
          durationsSeconds: normalizedDurations,
          modalities: modalities ?? [],
          providers: providers ?? [],
          includeActivityCurve: include_activity_curve ?? false,
          cursor: cursor ?? null,
          limit: limit ?? 100,
        }),
      );
    },
  );
}
