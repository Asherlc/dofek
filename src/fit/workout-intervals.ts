import type { FitStreamMetadata } from "./stream-decoder.ts";

/** Discriminator stored in `fitness.activity_interval.fit_source` for rows owned by this module. */
export const FIT_WORKOUT_LAP_SOURCE = "workout_step_lap" as const;

/**
 * FIT `message_index` and Lap `wkt_step_index` use the SDK's MessageIndex type, whose index mask
 * is 0x0FFF (`FIT_MESSAGE_INDEX_MASK` in `fit_profile.hpp`). Only plain indexes 0-4095 are
 * linked; values carrying flag bits are unsupported rather than guessed. Each identity map holds
 * at most 4,096 compact entries. Only link fields are retained (the original bytes are archived
 * separately) and sensor records are never buffered.
 */
const FIT_MAX_MESSAGE_INDEX = 0x0fff;

/** FIT `intensity` enum values (Garmin FIT SDK profile). */
const FIT_INTENSITY_NAMES: Record<number, string> = {
  0: "active",
  1: "rest",
  2: "warmup",
  3: "cooldown",
  4: "recovery",
  5: "interval",
  6: "other",
};

const FIT_FILE_TYPE_ACTIVITY = 4;
const FIT_DURATION_TYPE_TIME = 0;
const FIT_TARGET_TYPE_POWER = 4;
const FIT_CUSTOM_TARGET_VALUE = 0;
/** Garmin FIT stores absolute watts in custom power targets as watts + 1000. */
const FIT_ABSOLUTE_POWER_OFFSET = 1000;
const FIT_UINT32_INVALID = 0xffffffff;

type RawMessage = Record<string, unknown>;

const STEP_RAW_FIELDS = [
  "message_index",
  "wkt_step_name",
  "duration_type",
  "duration_value",
  "target_type",
  "target_value",
  "custom_target_value_low",
  "custom_target_value_high",
  "intensity",
] as const;
const LAP_RAW_FIELDS = [
  "message_index",
  "wkt_step_index",
  "start_time",
  "timestamp",
  "total_timer_time",
  "total_elapsed_time",
] as const;

const AMBIGUOUS = Symbol("ambiguous");

interface NormalizedStep {
  raw: RawMessage;
  label: string | null;
  intervalType: string | null;
  plannedDurationSeconds: number;
  targetPowerWatts: number | null;
  targetPowerMinWatts: number | null;
  targetPowerMaxWatts: number | null;
}

interface CompactLap {
  raw: RawMessage;
  stepIndex: number;
  start: Date;
  elapsedSeconds: number;
  timerSeconds: number | null;
}

export interface FitWorkoutInterval {
  intervalIndex: number;
  lapMessageIndex: number;
  stepMessageIndex: number;
  label: string | null;
  intervalType: string | null;
  startedAt: Date;
  endedAt: Date;
  plannedDurationSeconds: number;
  recordedTimerDurationSeconds: number | null;
  targetPowerWatts: number | null;
  targetPowerMinWatts: number | null;
  targetPowerMaxWatts: number | null;
  raw: {
    lap: RawMessage;
    workoutStep: RawMessage;
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fitIndex(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined &&
    Number.isInteger(number) &&
    number >= 0 &&
    number <= FIT_MAX_MESSAGE_INDEX
    ? number
    : undefined;
}

function dateValue(value: unknown): Date | undefined {
  const date =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function project(raw: RawMessage, fields: readonly string[]): RawMessage {
  const projected: RawMessage = {};
  for (const field of fields) {
    if (raw[field] !== undefined) projected[field] = raw[field];
  }
  return projected;
}

function absoluteWatts(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (
    number === undefined ||
    !Number.isInteger(number) ||
    number <= FIT_ABSOLUTE_POWER_OFFSET ||
    number >= FIT_UINT32_INVALID
  ) {
    return undefined;
  }
  return number - FIT_ABSOLUTE_POWER_OFFSET;
}

function normalizeStep(raw: RawMessage): NormalizedStep | undefined {
  if (raw.duration_type !== FIT_DURATION_TYPE_TIME) return undefined;
  if (raw.target_type !== FIT_TARGET_TYPE_POWER) return undefined;
  if (raw.target_value !== FIT_CUSTOM_TARGET_VALUE) return undefined;
  // FIT time duration_value is milliseconds.
  const milliseconds = finiteNumber(raw.duration_value);
  if (milliseconds === undefined || milliseconds <= 0) return undefined;
  const low = absoluteWatts(raw.custom_target_value_low);
  const high = absoluteWatts(raw.custom_target_value_high);
  if (low === undefined || high === undefined || low > high) return undefined;
  const intensity = finiteNumber(raw.intensity);
  return {
    raw: project(raw, STEP_RAW_FIELDS),
    label: typeof raw.wkt_step_name === "string" ? raw.wkt_step_name : null,
    intervalType: intensity === undefined ? null : (FIT_INTENSITY_NAMES[intensity] ?? null),
    plannedDurationSeconds: milliseconds / 1000,
    targetPowerWatts: low === high ? low : null,
    targetPowerMinWatts: low === high ? null : low,
    targetPowerMaxWatts: low === high ? null : high,
  };
}

function normalizeLap(raw: RawMessage): CompactLap | undefined {
  const stepIndex = fitIndex(raw.wkt_step_index);
  const start = dateValue(raw.start_time);
  const elapsed = finiteNumber(raw.total_elapsed_time);
  if (stepIndex === undefined || !start || elapsed === undefined || elapsed <= 0) return undefined;
  const timer = finiteNumber(raw.total_timer_time);
  return {
    raw: project(raw, LAP_RAW_FIELDS),
    stepIndex,
    start,
    elapsedSeconds: elapsed,
    timerSeconds: timer !== undefined && timer >= 0 && timer <= elapsed ? timer : null,
  };
}

function isEligibleFile(metadata: FitStreamMetadata): boolean {
  return (
    metadata.fileType === FIT_FILE_TYPE_ACTIVITY &&
    metadata.recoveryError === null &&
    metadata.sessionMessageCount === 1 &&
    metadata.workoutMessageCount === 1 &&
    metadata.workoutStepCount !== null &&
    metadata.workoutStepCount > 0 &&
    metadata.session?.sport.toLowerCase() === "cycling"
  );
}

/**
 * Collects Lap and Workout Step messages from one FIT stream and links them. A lap's
 * `wkt_step_index` must equal exactly one step's `message_index`; nothing is inferred. Entries
 * are keyed by message index, so a duplicated index marks that identity ambiguous.
 */
export class FitWorkoutIntervalCollector {
  readonly #steps = new Map<number, NormalizedStep | typeof AMBIGUOUS>();
  readonly #laps = new Map<number, CompactLap | typeof AMBIGUOUS>();

  addWorkoutSteps(messages: readonly RawMessage[]): void {
    for (const message of messages) {
      const index = fitIndex(message.message_index);
      if (index === undefined) continue;
      const normalized = this.#steps.has(index) ? undefined : normalizeStep(message);
      this.#steps.set(index, normalized ?? AMBIGUOUS);
    }
  }

  addLaps(messages: readonly RawMessage[]): void {
    for (const message of messages) {
      const index = fitIndex(message.message_index);
      if (index === undefined) continue;
      const normalized = this.#laps.has(index) ? undefined : normalizeLap(message);
      this.#laps.set(index, normalized ?? AMBIGUOUS);
    }
  }

  build(metadata: FitStreamMetadata): FitWorkoutInterval[] {
    const session = metadata.session;
    if (!session || !isEligibleFile(metadata)) return [];
    const sessionStart = session.startTime.getTime();
    const sessionEnd = sessionStart + session.totalElapsedTime * 1000;
    if (!Number.isFinite(sessionStart) || !Number.isFinite(sessionEnd)) return [];

    // Garmin's Workout header declares `num_valid_steps`; a step or lap link outside
    // 0 <= index < count cannot refer to a step of this workout.
    const declaredSteps = metadata.workoutStepCount ?? 0;
    const candidates: Array<Omit<FitWorkoutInterval, "intervalIndex">> = [];
    for (const [lapIndex, lap] of this.#laps) {
      if (lap === AMBIGUOUS) continue;
      const step = lap.stepIndex < declaredSteps ? this.#steps.get(lap.stepIndex) : undefined;
      if (!step || step === AMBIGUOUS) continue;
      // Garmin documents a Lap's span as start_time + total_elapsed_time; `timestamp` is
      // provenance only because its precision can differ.
      const endedAt = new Date(lap.start.getTime() + Math.round(lap.elapsedSeconds * 1000));
      if (!Number.isFinite(endedAt.getTime()) || endedAt.getTime() <= lap.start.getTime()) continue;
      if (lap.start.getTime() < sessionStart || endedAt.getTime() > sessionEnd) continue;
      candidates.push({
        lapMessageIndex: lapIndex,
        stepMessageIndex: lap.stepIndex,
        label: step.label,
        intervalType: step.intervalType,
        startedAt: lap.start,
        endedAt,
        plannedDurationSeconds: step.plannedDurationSeconds,
        recordedTimerDurationSeconds: lap.timerSeconds,
        targetPowerWatts: step.targetPowerWatts,
        targetPowerMinWatts: step.targetPowerMinWatts,
        targetPowerMaxWatts: step.targetPowerMaxWatts,
        raw: { lap: lap.raw, workoutStep: step.raw },
      });
    }
    candidates.sort(
      (a, b) =>
        a.startedAt.getTime() - b.startedAt.getTime() || a.lapMessageIndex - b.lapMessageIndex,
    );
    // Half-open windows may touch but not overlap; an overlapping lap is ambiguous, so both
    // sides are dropped rather than choosing one.
    const intervals: typeof candidates = [];
    let latestEnd = Number.NEGATIVE_INFINITY;
    candidates.forEach((candidate, position) => {
      const next = candidates[position + 1];
      const overlapsEarlier = candidate.startedAt.getTime() < latestEnd;
      const overlapsLater =
        next !== undefined && next.startedAt.getTime() < candidate.endedAt.getTime();
      latestEnd = Math.max(latestEnd, candidate.endedAt.getTime());
      if (!overlapsEarlier && !overlapsLater) intervals.push(candidate);
    });
    return intervals.map((interval, intervalIndex) => ({ ...interval, intervalIndex }));
  }
}
