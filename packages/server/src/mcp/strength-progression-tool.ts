import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { StrengthProgressionRepository } from "../repositories/strength-progression-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { strengthProgressionOutputSchema } from "./strength-progression-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register exact-range strength progression with source values and quality exclusions. */
export function registerStrengthProgressionTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_strength_progression",
    {
      title: "Get Strength Progression",
      description:
        "Return exact-range normalized exercise/set history, original provider values, RPE/RIR availability, named Epley e1RM estimates, volume and frequency trends, PR evidence, duplicate handling, and anomaly exclusions.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        providers: z.array(z.string().min(1)).max(50).optional(),
        exercise_ids: z.array(z.uuid()).max(100).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      outputSchema: strengthProgressionOutputSchema,
    },
    async ({ start_date, end_date, providers, exercise_ids, cursor, limit }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      return jsonToolResult(
        await new StrengthProgressionRepository(
          context.db,
          context.userId,
          context.timezone,
        ).listRange({
          startDate: start_date,
          endDate: end_date,
          providers: providers ?? [],
          exerciseIds: exercise_ids ?? [],
          cursor: cursor ?? null,
          limit: limit ?? 100,
        }),
      );
    },
  );
}
