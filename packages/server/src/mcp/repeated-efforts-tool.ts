import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { EFFORT_IDENTITY_KINDS } from "../repositories/repeated-effort-types.ts";
import { RepeatedEffortsRepository } from "../repositories/repeated-efforts-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import {
  repeatedEffortsOutputSchema,
  repeatedEffortsResultSchema,
} from "./repeated-efforts-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

export function registerRepeatedEffortsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "find_repeated_efforts",
    {
      title: "Find Repeated Efforts",
      description:
        "Discover provider-neutral repeated efforts: Level A exact namespaced workout/route/test identity; Level B strong geometry inference; Level C caller-asserted benchmarks (select user_defined_benchmark); Level D weak name/duration candidates (opt in with equivalence_strength: weak). Strong is the default. Preserves canonical/member/source evidence and quality flags. Repetition does not establish a maximal test or comparable conditions. Requests exceeding 2,000 activities or 250 route candidates must be narrowed; filters and repetition counts precede pagination.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        minimum_repetitions: z.number().int().min(2).max(2000).optional(),
        equivalence_strength: z.enum(["strong", "weak"]).optional(),
        effort_kind: z.enum(EFFORT_IDENTITY_KINDS).optional(),
        providers: z.array(z.string().min(1)).max(50).optional(),
        modalities: z.array(z.string().min(1)).max(20).optional(),
        canonical_types: z.array(z.string().min(1)).max(50).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      },
      outputSchema: repeatedEffortsOutputSchema,
    },
    async (input) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(input.start_date, input.end_date);
      if (!context.sensorStore)
        throw new Error("find_repeated_efforts requires the ClickHouse analytics store");
      const result = await new RepeatedEffortsRepository(
        context.db,
        context.sensorStore,
        context.userId,
        context.timezone,
      ).find({
        startDate: input.start_date,
        endDate: input.end_date,
        minimumRepetitions: input.minimum_repetitions ?? 2,
        equivalenceStrength: input.equivalence_strength ?? "strong",
        effortKind: input.effort_kind,
        providers: input.providers ?? [],
        modalities: input.modalities ?? [],
        canonicalTypes: input.canonical_types ?? [],
        limit: input.limit ?? 25,
        cursor: input.cursor ?? null,
      });
      return jsonToolResult(repeatedEffortsResultSchema.parse(result));
    },
  );
}
