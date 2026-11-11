import { climbingFiltersSchema } from "@dofek/training/climbing-filters";
import { FREE_ROCK_GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import {
  climbingResponseVersionSchema,
  toClimbingLogTraitsV1,
} from "@dofek/training/climbing-log-response";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import { dateSchema } from "../lib/date-schema.ts";
import { ClimbingProgressionRepository } from "../repositories/climbing-progression-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import { climbingProgressionOutputSchema } from "./climbing-progression-output.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register exact-range server-computed climbing progression analytics. */
export function registerClimbingProgressionTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_climbing_progression",
    {
      title: "Get Climbing Progression",
      description:
        "Return exact-range climbing frequency, grades, observed sends, attempts, relative volume, rolling exposure, session details, missing-data coverage, duplicate handling, and source/timezone provenance.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        providers: z.array(z.string().min(1)).max(50).optional(),
        filters: climbingFiltersSchema.optional(),
        locations: z.array(z.string().min(1)).max(50).optional(),
        grade_systems: z.array(z.enum(FREE_ROCK_GRADE_SYSTEMS)).max(20).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        response_version: climbingResponseVersionSchema.describe(
          "Defaults to 1 for scalar hold_type. Versions 2 and 3 return the complete hold_types collection.",
        ),
      }),
      outputSchema: climbingProgressionOutputSchema,
    },
    async ({
      start_date,
      end_date,
      providers,
      filters,
      locations,
      grade_systems,
      cursor,
      limit,
      response_version,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      const result = await new ClimbingProgressionRepository(
        context.db,
        context.userId,
        context.timezone,
        await loadClimbingGradePreference(context.db, context.userId),
      ).listRange({
        startDate: start_date,
        endDate: end_date,
        providers: providers ?? [],
        filters: filters ?? {},
        locations: locations ?? [],
        gradeSystems: grade_systems ?? [],
        cursor: cursor ?? null,
        limit: limit ?? 100,
      });
      if (response_version !== 1) return jsonToolResult(result);
      return jsonToolResult({
        ...result,
        sessions: result.sessions.map((session) => ({
          ...session,
          climbing_log_entries: session.climbing_log_entries.map(({ hold_types, ...entry }) => ({
            ...entry,
            hold_type: toClimbingLogTraitsV1({ holdTypes: hold_types, wallAngle: null }).holdType,
          })),
        })),
      });
    },
  );
}
