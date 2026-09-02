import { gradeSortValue } from "@dofek/training/climbing-grades";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { type McpScope, requireMcpScope } from "./token-repository.ts";
import { assertDateRange, jsonContent } from "./tool-utils.ts";

const trainingSessionActivitySchema = z.object({
  avg_hr: z.coerce.number().nullable(),
  ended_at: z.string().nullable(),
  id: z.string(),
  name: z.string().nullable(),
  started_at: z.string(),
});

function requireActivityRead(scopes: McpScope[]): void {
  requireMcpScope(scopes, "activity:read");
}

export function registerTrainingSessionTools(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_climbing_sessions",
    {
      title: "Get Climbing Sessions",
      description:
        "Return exact-range climbing sessions with route/problem details, heart rate, duration, grade distribution, send rate, maximum grade, and volume.",
      annotations: { readOnlyHint: true },
      inputSchema: { start_date: dateSchema, end_date: dateSchema },
    },
    async ({ start_date, end_date }) => {
      requireActivityRead(context.scopes);
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
      ).map((row) => trainingSessionActivitySchema.parse(row));
      const sessions = [];
      for (const activity of activities) {
        const entries = (await climbingRepository.getActivityEntries(activity.id)).map((entry) =>
          entry.toDetail(),
        );
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
          location: entries.find((entry) => entry.locationName !== null)?.locationName ?? null,
          climbs: entries,
        });
      }
      const climbs = sessions.flatMap((session) => session.climbs);
      const gradeDistribution = new Map<
        string,
        {
          discipline: "boulder" | "route";
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
        const key = `${climb.climbType}:${climb.gradeSystem}:${climb.grade}`;
        const distribution = gradeDistribution.get(key) ?? {
          discipline: climb.climbType,
          grade: climb.grade,
          grade_system: climb.gradeSystem,
          attempts: 0,
          sends: 0,
        };
        distribution.attempts += climb.attemptCount;
        if (climb.sent) distribution.sends += 1;
        gradeDistribution.set(key, distribution);
        if (climb.sent) {
          const sort = gradeSortValue(climb.grade, climb.gradeSystem);
          const current = maxGrade[climb.climbType];
          if (sort !== null && (current === null || sort > current.sort)) {
            maxGrade[climb.climbType] = { grade: climb.grade, sort };
          }
        }
      }
      const sends = climbs.filter((climb) => climb.sent).length;
      return jsonContent({
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
            attempts: climbs.reduce((sum, climb) => sum + climb.attemptCount, 0),
            sends,
          },
        },
      });
    },
  );

  server.registerTool(
    "get_strength_sessions",
    {
      title: "Get Strength Sessions",
      description:
        "Return exact-range strength sessions with exercises, sets, session volume-load, and volume-load by muscle group.",
      annotations: { readOnlyHint: true },
      inputSchema: { start_date: dateSchema, end_date: dateSchema },
    },
    async ({ start_date, end_date }) => {
      requireActivityRead(context.scopes);
      assertDateRange(start_date, end_date);
      const activityRepository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const strengthRepository = new StrengthRepository(
        context.db,
        context.userId,
        context.timezone,
      );
      const activities = (
        await activityRepository.listRange(start_date, end_date, ["strength"])
      ).map((row) => trainingSessionActivitySchema.parse(row));
      const muscleGroupVolume = new Map<string, number>();
      let totalVolumeLoadKg = 0;
      const sessions = [];
      for (const activity of activities) {
        const exercises = (await strengthRepository.getExercisesForActivity(activity.id)).map(
          (exercise) => exercise.toDetail(),
        );
        let sessionVolumeLoadKg = 0;
        for (const exercise of exercises) {
          const exerciseVolume = exercise.sets.reduce(
            (sum, set) =>
              sum + (set.weightKg === null || set.reps === null ? 0 : set.weightKg * set.reps),
            0,
          );
          sessionVolumeLoadKg += exerciseVolume;
          for (const muscleGroup of exercise.muscleGroups ?? []) {
            muscleGroupVolume.set(
              muscleGroup,
              (muscleGroupVolume.get(muscleGroup) ?? 0) + exerciseVolume,
            );
          }
        }
        totalVolumeLoadKg += sessionVolumeLoadKg;
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
          volume_load_kg: sessionVolumeLoadKg,
          exercises,
        });
      }
      return jsonContent({
        sessions,
        aggregates: {
          volume_load_kg: totalVolumeLoadKg,
          by_muscle_group: [...muscleGroupVolume.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([muscle_group, volume_load_kg]) => ({ muscle_group, volume_load_kg })),
        },
      });
    },
  );
}
