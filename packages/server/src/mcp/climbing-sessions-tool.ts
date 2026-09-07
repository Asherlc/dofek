import { gradeSortValue } from "@dofek/training/climbing-grades";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { climbingSessionsOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const climbingSessionActivitySchema = z.object({
  avg_hr: z.coerce.number().nullable(),
  ended_at: z.string().nullable(),
  id: z.string(),
  name: z.string().nullable(),
  started_at: z.string(),
});

type ClimbingDiscipline = "boulder" | "lead" | "top_rope" | "route";

function disciplineFor(climb: {
  climbType: "boulder" | "route";
  lead?: boolean | null;
}): ClimbingDiscipline {
  if (climb.climbType === "boulder") return "boulder";
  if (climb.lead === true) return "lead";
  if (climb.lead === false) return "top_rope";
  return "route";
}

/** Register exact-range climbing session details and aggregates. */
export function registerClimbingSessionsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_climbing_sessions",
    {
      title: "Get Climbing Sessions",
      description:
        "Return exact-range climbing sessions with route/problem details, heart rate, duration, grade distribution, send rate, maximum grade, and volume.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: { start_date: dateSchema, end_date: dateSchema },
      outputSchema: climbingSessionsOutputSchema,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      const activityRepository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const climbingRepository = new ClimbingRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
      );
      const activities = (
        await activityRepository.listRange(start_date, end_date, ["climbing"])
      ).map((row) => climbingSessionActivitySchema.parse(row));
      const sessions = [];
      for (const activity of activities) {
        const entries = (await climbingRepository.getActivityEntries(activity.id)).map((entry) => {
          const detail = entry.toDetail();
          return {
            id: detail.id,
            discipline: disciplineFor(detail),
            grade: detail.grade,
            grade_system: detail.gradeSystem,
            sent: detail.sent,
            attempt_count: detail.attemptCount,
            attempts: detail.attempts,
            ascent_type: detail.ascentType,
            hold_type: detail.holdType,
            route_name: detail.routeName,
            location_name: detail.locationName,
            source_name: detail.sourceName,
            wall_angle_degrees: detail.wallAngleDegrees,
          };
        });
        sessions.push({
          activity_id: activity.id,
          started_at: activity.started_at,
          duration_minutes:
            activity.ended_at === null
              ? null
              : (new Date(activity.ended_at).getTime() - new Date(activity.started_at).getTime()) /
                60_000,
          avg_hr: activity.avg_hr,
          name: activity.name,
          gym_vs_crag: null,
          location: entries.find((entry) => entry.location_name !== null)?.location_name ?? null,
          total_vertical_m: null,
          climbs: entries,
        });
      }
      const climbs = sessions.flatMap((session) => session.climbs);
      const gradeDistribution = new Map<
        string,
        {
          discipline: ClimbingDiscipline;
          grade: string;
          grade_system: string;
          attempts: number;
          sends: number;
        }
      >();
      const maxGrade: Record<"boulder" | "route", { grade: string; sort: number } | null> = {
        boulder: null,
        route: null,
      };
      for (const climb of climbs) {
        const key = `${climb.discipline}:${climb.grade_system}:${climb.grade}`;
        const distribution = gradeDistribution.get(key) ?? {
          discipline: climb.discipline,
          grade: climb.grade,
          grade_system: climb.grade_system,
          attempts: 0,
          sends: 0,
        };
        distribution.attempts += climb.attempt_count;
        if (climb.sent) distribution.sends += 1;
        gradeDistribution.set(key, distribution);
        if (climb.sent) {
          const climbType = climb.discipline === "boulder" ? "boulder" : "route";
          const sort = gradeSortValue(climb.grade, climb.grade_system);
          const current = maxGrade[climbType];
          if (sort !== null && (current === null || sort > current.sort)) {
            maxGrade[climbType] = { grade: climb.grade, sort };
          }
        }
      }
      const sends = climbs.filter((climb) => climb.sent).length;
      return jsonToolResult({
        sessions,
        aggregates: {
          grade_distribution: [...gradeDistribution.values()],
          send_rate: climbs.length === 0 ? null : sends / climbs.length,
          max_grade_by_discipline: {
            boulder: maxGrade.boulder?.grade ?? null,
            route: maxGrade.route?.grade ?? null,
          },
          volume: {
            climbs: climbs.length,
            attempts: climbs.reduce((sum, climb) => sum + climb.attempt_count, 0),
            sends,
            total_vertical_m: null,
          },
        },
      });
    },
  );
}
