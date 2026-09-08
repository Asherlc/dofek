import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { fingerLoadingExerciseSchema } from "../repositories/climbing-training-log-repository.ts";
import { FingerLoadingProgressionRepository } from "../repositories/finger-loading-progression-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { fingerLoadingProgressionOutputSchema } from "./finger-loading-progression-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register exact-range finger/hangboard loading analytics. */
export function registerFingerLoadingProgressionTool(
  server: McpServer,
  context: DofekMcpContext,
): void {
  server.registerTool(
    "get_finger_loading_progression",
    {
      title: "Get Finger Loading Progression",
      description:
        "Return exact-range finger/hangboard protocols, effective load, load ratio, time-under-tension, kg-second exposure, consecutive days, explicit-threshold high-intensity days, and source/timezone provenance as a separate load channel.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        providers: z.array(z.string().min(1)).max(50).optional(),
        protocols: z.array(fingerLoadingExerciseSchema).max(6).optional(),
        min_effective_load_kg: z.number().positive().optional(),
        min_load_to_bodyweight_ratio: z.number().positive().optional(),
        min_rpe: z.number().min(0).max(10).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: fingerLoadingProgressionOutputSchema,
    },
    async ({
      start_date,
      end_date,
      providers,
      protocols,
      min_effective_load_kg,
      min_load_to_bodyweight_ratio,
      min_rpe,
      cursor,
      limit,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      return jsonToolResult(
        await new FingerLoadingProgressionRepository(
          context.db,
          context.userId,
          context.timezone,
        ).listRange({
          startDate: start_date,
          endDate: end_date,
          providers: providers ?? [],
          exercises: protocols ?? [],
          thresholds: {
            minEffectiveLoadKg: min_effective_load_kg ?? null,
            minLoadToBodyweightRatio: min_load_to_bodyweight_ratio ?? null,
            minRpe: min_rpe ?? null,
          },
          cursor: cursor ?? null,
          limit: limit ?? 100,
        }),
      );
    },
  );
}
