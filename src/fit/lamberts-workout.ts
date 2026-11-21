import { z } from "zod";
import type { FitWorkoutStructureMessage } from "./stream-decoder.ts";

// Lamberts et al., doi:10.1136/bjsm.2009.061325, Methods and Figure 2.
const protocol = [
  { segment: "lsct_stage_1", seconds: 360, target: 60 },
  { segment: "lsct_calibration", seconds: 30, target: null },
  { segment: "lsct_stage_2", seconds: 360, target: 80 },
  { segment: "lsct_stage_3", seconds: 180, target: 90 },
  { segment: "lsct_recovery", seconds: 90, target: null },
] as const;

export const lambertsFitSegments = protocol.map(({ segment }) => segment);
// One Workout, one optional Zones Target, and one prescribed step and linked lap per segment.
export const maximumLambertsWorkoutObservations = 2 + 2 * protocol.length;

// FIT SDK Profile and the Garmin Workout file specification.
const fitCycling = 2;
const fitTime = 0;
const fitHeartRate = 1;
const fitOpen = 2;
const fitRest = 1;
const fitRecovery = 4;

const workoutNames = new Set([
  "lsct",
  "lamberts submaximal cycle test",
  "lamberts and lambert submaximal cycle test",
]);

const workoutSchema = z.object({
  wkt_name: z.string().trim(),
  sport: z.literal(fitCycling),
  num_valid_steps: z.literal(protocol.length),
});

const lapSchema = z.object({
  start_time: z.iso.datetime(),
  timestamp: z.iso.datetime(),
  total_elapsed_time: z.number(),
  total_timer_time: z.number(),
});

export interface LambertsFitWorkout {
  workout: Record<string, unknown>;
  zonesTarget: Record<string, unknown> | null;
  intervals: {
    segment: (typeof protocol)[number]["segment"];
    start: Date;
    end: Date;
    targetMaximumHeartRatePercent: number | null;
    lap: Record<string, unknown>;
    step: Record<string, unknown>;
  }[];
}

function matchesStep(step: Record<string, unknown>, spec: (typeof protocol)[number]) {
  if (step.duration_type !== fitTime || step.duration_value !== spec.seconds * 1_000) {
    return false;
  }
  if (spec.target === null) {
    return (
      step.target_type === fitOpen && (step.intensity === fitRest || step.intensity === fitRecovery)
    );
  }
  return (
    step.target_type === fitHeartRate &&
    step.target_value === 0 &&
    step.custom_target_value_low === spec.target &&
    step.custom_target_value_high === spec.target
  );
}

/** Match documented FIT workout steps to executed laps. Signal shape cannot identify the test. */
export function matchLambertsWorkout(
  messages: readonly FitWorkoutStructureMessage[],
): LambertsFitWorkout | null {
  const workouts = messages.filter((message) => message.messageType === "workout");
  const steps = messages.filter((message) => message.messageType === "workout_step");
  const laps = messages.filter(
    (message) => message.messageType === "lap" && message.raw.wkt_step_index !== undefined,
  );
  const zoneMessages = messages.filter((message) => message.messageType === "zones_target");
  const workout = workouts[0]?.raw;
  if (
    !workout ||
    workouts.length !== 1 ||
    steps.length !== protocol.length ||
    laps.length !== protocol.length ||
    zoneMessages.length > 1
  ) {
    return null;
  }
  const parsedWorkout = workoutSchema.safeParse(workout);
  if (
    !parsedWorkout.success ||
    !workoutNames.has(parsedWorkout.data.wkt_name.toLowerCase().replace(/[\s-]+/g, " "))
  ) {
    return null;
  }

  const intervals: LambertsFitWorkout["intervals"] = [];
  for (const [index, spec] of protocol.entries()) {
    const step = steps.find((message) => message.raw.message_index === index)?.raw;
    const lap = laps.find((message) => message.raw.wkt_step_index === index)?.raw;
    if (!step || !lap || !matchesStep(step, spec)) return null;

    const parsedLap = lapSchema.safeParse(lap);
    if (!parsedLap.success) return null;

    const start = new Date(parsedLap.data.start_time);
    const end = new Date(parsedLap.data.timestamp);
    const previousEnd = intervals.at(-1)?.end.getTime();
    if (
      parsedLap.data.total_elapsed_time !== spec.seconds ||
      parsedLap.data.total_timer_time !== spec.seconds ||
      end.getTime() - start.getTime() !== spec.seconds * 1_000 ||
      (previousEnd !== undefined && previousEnd !== start.getTime())
    ) {
      return null;
    }

    intervals.push({
      segment: spec.segment,
      start,
      end,
      targetMaximumHeartRatePercent: spec.target,
      lap,
      step,
    });
  }

  return {
    workout,
    zonesTarget: zoneMessages[0]?.raw ?? null,
    intervals,
  };
}
