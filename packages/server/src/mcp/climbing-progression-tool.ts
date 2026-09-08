import { CLIMBING_GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { ClimbingProgressionRepository } from "../repositories/climbing-progression-repository.ts";
import { climbingProgressionOutputSchema } from "./climbing-progression-output.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register exact-range server-computed climbing progression analytics. */
export function registerClimbingProgressionTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_climbing_progression",
    {
      title: "Get Climbing Progression",
      description:
        "Return exact-range climbing frequency, grades, observed sends, attempts, relative volume, rolling exposure, session details, missing-data coverage, duplicate handling, and source/timezone provenance.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        providers: z.array(z.string().min(1)).max(50).optional(),
        disciplines: z
          .array(z.enum(["boulder", "lead", "top_rope", "route"]))
          .max(4)
          .optional(),
        locations: z.array(z.string().min(1)).max(50).optional(),
        grade_systems: z.array(z.enum(CLIMBING_GRADE_SYSTEMS)).max(20).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: climbingProgressionOutputSchema,
    },
    async ({
      start_date,
      end_date,
      providers,
      disciplines,
      locations,
      grade_systems,
      cursor,
      limit,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      return jsonToolResult(
        await new ClimbingProgressionRepository(
          context.db,
          context.userId,
          context.timezone,
        ).listRange({
          startDate: start_date,
          endDate: end_date,
          providers: providers ?? [],
          disciplines: disciplines ?? [],
          locations: locations ?? [],
          gradeSystems: grade_systems ?? [],
          cursor: cursor ?? null,
          limit: limit ?? 100,
        }),
      );
    },
  );
}
