import { randomUUID } from "node:crypto";
import type { WhoopCycle } from "@dofek/whoop/types";
import { z } from "zod";

export const WHOOP_CYCLE_WINDOW_MS = 200 * 24 * 60 * 60 * 1000;

const whoopCycleSchema = z.custom<WhoopCycle>(
  (value): value is WhoopCycle => typeof value === "object" && value !== null,
);

const whoopSyncStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("strain_deep_dive"), date: z.string() }),
  z.object({ type: z.literal("sleep_stages"), sleepId: z.string() }),
  z.object({
    type: z.literal("developer_workouts"),
    nextToken: z.string().optional(),
  }),
  z.object({ type: z.literal("persist_workouts") }),
  z.object({ type: z.literal("weightlifting"), activityId: z.string() }),
  z.object({ type: z.literal("heart_rate"), start: z.string(), end: z.string() }),
  z.object({ type: z.literal("journal") }),
]);

export type WhoopSyncStep = z.infer<typeof whoopSyncStepSchema>;

export const whoopSyncCheckpointSchema = z.object({
  runId: z.string(),
  recordsSynced: z.number().default(0),
  phase: z.enum(["bootstrap", "api", "done"]),
  cycleFetchCursorMs: z.number().nullable().optional(),
  cycles: z.array(whoopCycleSchema).default([]),
  apiSteps: z.array(whoopSyncStepSchema).default([]),
  apiStepIndex: z.number().default(0),
  presentExternalIds: z.array(z.string()).default([]),
  developerActivityTypeNamesById: z.record(z.string(), z.string()).default({}),
  developerWorkoutPaginationComplete: z.boolean().optional(),
});

type ParsedWhoopSyncCheckpoint = z.infer<typeof whoopSyncCheckpointSchema>;
export type WhoopSyncCheckpoint = ParsedWhoopSyncCheckpoint & {
  developerWorkoutPaginationComplete: boolean;
};

export function createWhoopSyncCheckpoint(windowStartMs: number): WhoopSyncCheckpoint {
  return {
    runId: randomUUID(),
    recordsSynced: 0,
    phase: "bootstrap",
    cycleFetchCursorMs: windowStartMs,
    cycles: [],
    apiSteps: [],
    apiStepIndex: 0,
    presentExternalIds: [],
    developerActivityTypeNamesById: {},
    developerWorkoutPaginationComplete: false,
  };
}

export function parseWhoopSyncCheckpoint(raw: unknown): WhoopSyncCheckpoint | null {
  const parsed = whoopSyncCheckpointSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    developerWorkoutPaginationComplete: parsed.data.developerWorkoutPaginationComplete ?? false,
  };
}
