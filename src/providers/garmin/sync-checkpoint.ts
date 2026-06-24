import { randomUUID } from "node:crypto";
import { z } from "zod";

const garminSyncStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activities_list") }),
  z.object({
    type: z.literal("activity_detail"),
    activityId: z.number(),
    activityType: z.string(),
  }),
  z.object({ type: z.literal("activity_reconcile") }),
  z.object({ type: z.literal("sleep"), date: z.string() }),
  z.object({ type: z.literal("daily_summary"), date: z.string() }),
  z.object({ type: z.literal("hrv_summary"), date: z.string() }),
  z.object({ type: z.literal("stress"), date: z.string() }),
  z.object({ type: z.literal("heart_rate"), date: z.string() }),
]);

export type GarminSyncStep = z.infer<typeof garminSyncStepSchema>;

export const garminSyncCheckpointSchema = z.object({
  runId: z.string(),
  recordsSynced: z.number().default(0),
  phase: z.enum(["api", "done"]),
  steps: z.array(garminSyncStepSchema).default([]),
  stepIndex: z.number().default(0),
  presentActivityExternalIds: z.array(z.string()).default([]),
});

export type GarminSyncCheckpoint = z.infer<typeof garminSyncCheckpointSchema>;

export function createGarminSyncCheckpoint(steps: GarminSyncStep[]): GarminSyncCheckpoint {
  return {
    runId: randomUUID(),
    recordsSynced: 0,
    phase: "api",
    steps,
    stepIndex: 0,
    presentActivityExternalIds: [],
  };
}

export function parseGarminSyncCheckpoint(raw: unknown): GarminSyncCheckpoint | null {
  const parsed = garminSyncCheckpointSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { stepIndex, recordsSynced, steps } = parsed.data;
  if (stepIndex < 0 || stepIndex > steps.length || recordsSynced < 0) return null;
  return parsed.data;
}

export function insertStepsAfterCurrent(
  checkpoint: GarminSyncCheckpoint,
  steps: GarminSyncStep[],
): GarminSyncCheckpoint {
  if (steps.length === 0) return checkpoint;
  const head = checkpoint.steps.slice(0, checkpoint.stepIndex + 1);
  const tail = checkpoint.steps.slice(checkpoint.stepIndex + 1);
  return {
    ...checkpoint,
    steps: [...head, ...steps, ...tail],
  };
}

/** Garmin rate limits are per account — preserve the full step plan and retry later. */
export function applyRateLimitToCheckpoint(checkpoint: GarminSyncCheckpoint): GarminSyncCheckpoint {
  return checkpoint;
}
