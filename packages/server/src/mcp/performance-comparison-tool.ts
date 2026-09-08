import { ACTIVITY_MODALITIES, CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import { CLIMBING_GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import {
  PerformanceComparisonRepository,
  type PerformanceEquivalence,
} from "../repositories/performance-comparison-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { performanceComparisonOutputSchema } from "./performance-comparison-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const equivalenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("provider_workout_id"),
      provider: z.literal("peloton"),
      value: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cycling_route"),
      provider: z.string().min(1),
      activity_name: z.string().min(1),
      provider_type: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("standardized_test"),
      provider: z.string().min(1),
      activity_name: z.string().min(1),
      provider_type: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("climb"),
      climb_type: z.enum(["boulder", "route"]),
      grade_system: z.enum(CLIMBING_GRADE_SYSTEMS),
      grade: z.string().min(1),
      route_name: z.string().min(1),
      location_name: z.string().min(1),
      lead: z.boolean().nullable().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("strength_exercise_id"), exercise_id: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("activity_name"),
      canonical_type: z.enum(CANONICAL_ACTIVITY_TYPES),
      value: z.string().min(1),
    })
    .strict(),
]);

type ToolEquivalence = z.infer<typeof equivalenceSchema>;

function toRepositoryEquivalence(input: ToolEquivalence): PerformanceEquivalence {
  if (input.kind === "strength_exercise_id") {
    return { kind: input.kind, exerciseId: input.exercise_id };
  }
  if (input.kind === "activity_name") {
    return { kind: input.kind, canonicalType: input.canonical_type, value: input.value };
  }
  if (input.kind === "standardized_test") {
    return {
      kind: input.kind,
      provider: input.provider,
      activityName: input.activity_name,
      providerType: input.provider_type,
    };
  }
  if (input.kind === "cycling_route") {
    return {
      kind: input.kind,
      provider: input.provider,
      activityName: input.activity_name,
      providerType: input.provider_type,
    };
  }
  if (input.kind === "climb") {
    return {
      kind: input.kind,
      climbType: input.climb_type,
      gradeSystem: input.grade_system,
      grade: input.grade,
      routeName: input.route_name,
      locationName: input.location_name,
      lead: input.lead ?? null,
    };
  }
  return input;
}

/** Register equivalence-constrained longitudinal performance comparison. */
export function registerPerformanceComparisonTool(
  server: McpServer,
  context: DofekMcpContext,
): void {
  server.registerTool(
    "compare_performances",
    {
      title: "Compare Equivalent Performances",
      description:
        "Compare repeated Peloton classes, caller-asserted provider-scoped cycling routes, climbs, normalized strength exercises, standardized tests, or exact activity names. Requires explicit equivalence evidence and returns contextual metrics, deltas, quality, and provenance without causal claims.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        reference_activity_id: z.uuid().optional(),
        equivalence: equivalenceSchema.optional(),
        providers: z.array(z.string().min(1)).max(50).optional(),
        modalities: z.array(z.enum(ACTIVITY_MODALITIES)).max(ACTIVITY_MODALITIES.length).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: performanceComparisonOutputSchema,
    },
    async ({
      start_date,
      end_date,
      reference_activity_id,
      equivalence,
      providers,
      modalities,
      cursor,
      limit,
    }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (!reference_activity_id && !equivalence) {
        throw new Error("compare_performances requires reference_activity_id or equivalence");
      }
      if (!context.sensorStore) {
        throw new Error("compare_performances requires the ClickHouse analytics store");
      }
      return jsonToolResult(
        await new PerformanceComparisonRepository(
          context.db,
          context.sensorStore,
          context.userId,
          context.timezone,
        ).compare({
          startDate: start_date,
          endDate: end_date,
          referenceActivityId: reference_activity_id ?? null,
          equivalence: equivalence ? toRepositoryEquivalence(equivalence) : null,
          providers: providers ?? [],
          modalities: modalities ?? [],
          cursor: cursor ?? null,
          limit: limit ?? 25,
        }),
      );
    },
  );
}
