import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingTrainingMetricsRepository } from "../repositories/cycling-training-metrics-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { cyclingTrainingMetricsOutputSchema } from "./cycling-training-metrics-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const STANDARD_DURATIONS_SECONDS = [
  1, 5, 15, 30, 60, 120, 180, 300, 420, 600, 720, 1200, 1800, 2400, 3600, 5400, 7200,
] as const;
const standardDurationSet = new Set<number>(STANDARD_DURATIONS_SECONDS);
const durationSchema = z
  .number()
  .int()
  .refine((duration) => standardDurationSet.has(duration), {
    message: "best-power duration must be a supported standard duration",
  });

/** Register server-computed, coverage-aware per-ride cycling metrics. */
export function registerCyclingTrainingMetricsTool(
  server: McpServer,
  context: DofekMcpContext,
): void {
  server.registerTool(
    "get_cycling_training_metrics",
    {
      title: "Get Cycling Training Metrics",
      description:
        "Return paginated per-ride normalized power, variability, work, historical FTP-dependent load, power and heart-rate zones, aerobic efficiency, cardiac drift, best powers, and recorded or explicitly inferred intervals. Results preserve merged-activity, sample, device, timezone, coverage, and availability evidence; raw streams remain server-side.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        modalities: z.array(z.string().min(1)).max(20).optional(),
        providers: z.array(z.string().min(1)).max(50).optional(),
        best_power_durations_seconds: z.array(durationSchema).min(1).max(17).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      outputSchema: cyclingTrainingMetricsOutputSchema,
    },
    async ({
      start_date,
      end_date,
      modalities,
      providers,
      best_power_durations_seconds,
      cursor,
      limit,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("get_cycling_training_metrics requires the ClickHouse analytics store");
      }
      const durations = best_power_durations_seconds ?? [...STANDARD_DURATIONS_SECONDS];
      if (new Set(durations).size !== durations.length) {
        throw new Error("best_power_durations_seconds must be unique");
      }
      return jsonToolResult(
        await new CyclingTrainingMetricsRepository(
          context.db,
          context.sensorStore,
          context.userId,
          context.timezone,
        ).listRange({
          startDate: start_date,
          endDate: end_date,
          modalities: modalities ?? [],
          providers: providers ?? [],
          durationsSeconds: [...durations].sort((left, right) => left - right),
          cursor: cursor ?? null,
          limit: limit ?? 10,
        }),
      );
    },
  );
}
