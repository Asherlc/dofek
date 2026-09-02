import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonContent, mapWithConcurrency } from "./tool-utils.ts";

const trainingSessionActivitySchema = z.object({
  avg_hr: z.coerce.number().nullable(),
  ended_at: z.string().nullable(),
  id: z.string(),
  name: z.string().nullable(),
  started_at: z.string(),
});

/** Register exact-range strength session details and volume load. */
export function registerStrengthSessionsTool(server: McpServer, context: DofekMcpContext): void {
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
      requireMcpScope(context.scopes, "activity:read");
      if (start_date > end_date) throw new Error("start_date must be on or before end_date");
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
      const sessions = await mapWithConcurrency(activities, 8, async (activity) => {
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
        return {
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
        };
      });
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
