import type { FreeRockGradeSystem, RockClimbKind } from "@dofek/training/climbing-grades";
import { climbingResponseVersionSchema } from "@dofek/training/climbing-log-response";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadClimbingGradePreference } from "../climbing-grade-preferences.ts";
import { serializeClimbingLogEntryDetailResponse } from "../contracts/climbing-log-contracts.ts";
import { dateSchema } from "../lib/date-schema.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { climbingSessionsOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const sessionActivitySchema = z.object({
  avg_hr: z.coerce.number().nullable(),
  ended_at: z.string().nullable(),
  id: z.string(),
  name: z.string().nullable(),
  started_at: z.string(),
  canonical_type: z.string(),
});

export function registerClimbingSessionsTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["activity:read"],
    "get_climbing_sessions",
    {
      title: "Get Climbing Sessions",
      description:
        "Return exact-range climbing and logged hiking outings with shared climbs, pitches, recorded attempt facts and source attribution. Rock metrics use whole attempts and one compatible published grade; generic completion and pitch results remain separately scoped in each log.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        start_date: dateSchema,
        end_date: dateSchema,
        response_version: climbingResponseVersionSchema.describe(
          "Defaults to 1 for legacy climbing traits. Use 2 for multiple grips and categorical wall angles.",
        ),
      }),
      outputSchema: climbingSessionsOutputSchema,
    },
    async ({ start_date, end_date, response_version }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      const preference = await loadClimbingGradePreference(context.db, context.userId);
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
        preference,
      );
      const activities = (
        await activityRepository.listRange(start_date, end_date, ["climbing", "hiking"])
      ).map((row) => sessionActivitySchema.parse(row));
      const sessions = [];
      for (const activity of activities) {
        const logs = (await climbingRepository.getActivityLogEntries(activity.id)).map((log) =>
          log.toDetail(),
        );
        if (activity.canonical_type === "hiking" && !logs.length) continue;
        sessions.push({
          activity_id: activity.id,
          started_at: activity.started_at,
          duration_minutes:
            activity.ended_at === null
              ? null
              : (Date.parse(activity.ended_at) - Date.parse(activity.started_at)) / 60000,
          avg_hr: activity.avg_hr,
          name: activity.name,
          location:
            logs.find((log) => log.climb?.areaPath.length)?.climb?.areaPath.at(-1)?.name ?? null,
          climbing_log_entries: logs.map((log) =>
            serializeClimbingLogEntryDetailResponse(log, response_version),
          ),
        });
      }
      const observations = await climbingRepository.getAttachedRockObservations(
        start_date,
        end_date,
      );
      const distributions = new Map<
        string,
        {
          climb_kind: RockClimbKind;
          grade: string;
          grade_system: FreeRockGradeSystem;
          recorded_attempts: number | null;
          sends: number;
        }
      >();
      const hardest = new Map<RockClimbKind, { grade: string; sort: number }>();
      for (const observation of observations) {
        const grade = observation.displayGrade;
        if (!grade) continue;
        const key = `${observation.climbKind}:${grade.gradeSystem}:${grade.grade}`;
        const bucket = distributions.get(key) ?? {
          climb_kind: observation.climbKind,
          grade: grade.grade,
          grade_system: grade.gradeSystem,
          recorded_attempts: 0,
          sends: 0,
        };
        bucket.recorded_attempts =
          bucket.recorded_attempts === null || observation.recordedAttempts === null
            ? null
            : bucket.recorded_attempts + observation.recordedAttempts;
        bucket.sends += observation.sends;
        distributions.set(key, bucket);
        const current = hardest.get(observation.climbKind);
        if (observation.sends > 0 && (!current || grade.gradeSortValue > current.sort))
          hardest.set(observation.climbKind, { grade: grade.grade, sort: grade.gradeSortValue });
      }
      const recordedAttempts = observations.some(
        (observation) => observation.recordedAttempts === null,
      )
        ? null
        : observations.reduce((sum, observation) => sum + (observation.recordedAttempts ?? 0), 0);
      const sends = observations.reduce((sum, observation) => sum + observation.sends, 0);
      const observedOutcomes = observations.reduce(
        (sum, observation) => sum + observation.observedOutcomes,
        0,
      );
      return jsonToolResult({
        sessions,
        aggregates: {
          grade_distribution: [...distributions.values()],
          send_rate: observedOutcomes === 0 ? null : sends / observedOutcomes,
          max_grade_by_kind: {
            boulder: hardest.get("boulder")?.grade ?? null,
            route: hardest.get("route")?.grade ?? null,
          },
          volume: {
            rock_log_entries: observations.length,
            recorded_attempts: recordedAttempts,
            sends,
          },
          coverage: {
            rock_log_entries: observations.length,
            observed_free_send_outcomes: observedOutcomes,
            unknown_free_send_outcomes: observations.reduce(
              (sum, observation) => sum + observation.unknownOutcomes,
              0,
            ),
          },
        },
      });
    },
  );
}
