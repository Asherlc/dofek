import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import { readFingerLoadingActivity } from "../repositories/climbing-training-log-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Register one-activity structured training details. */
export function registerActivityDetailsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_activity_details",
    {
      title: "Get Activity Details",
      description:
        "Return one authenticated user's activity with its strength exercises and sets, climbing entries, and finger-loading details.",
      annotations: { readOnlyHint: true },
      inputSchema: { activity_id: z.uuid() },
    },
    async ({ activity_id }) => {
      requireMcpScope(context.scopes, "activity:read");
      const activityRepository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const activity = await activityRepository.findById(activity_id);
      if (!activity) throw new Error("Activity not found.");
      const [strengthExercises, climbingEntries, fingerLoading] = await Promise.all([
        new StrengthRepository(
          context.db,
          context.userId,
          context.timezone,
        ).getExercisesForActivity(activity_id),
        new ClimbingRepository(context.db, context.userId, context.timezone, {
          kind: "full",
          paid: true,
          reason: "paid_grant",
        }).getActivityEntries(activity_id),
        readFingerLoadingActivity({
          activityId: activity_id,
          database: context.db,
          userId: context.userId,
        }),
      ]);
      return jsonContent({
        activity,
        climbing_entries: climbingEntries.map((entry) => entry.toDetail()),
        finger_loading: fingerLoading,
        strength_exercises: strengthExercises.map((exercise) => exercise.toDetail()),
      });
    },
  );
}
