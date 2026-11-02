import { resampleSignal } from "@dofek/cycling-power/resample-signal";
import { cyclingPowerCoveragePolicy } from "./cycling-power-policy.ts";

export interface CyclingWorkoutSample {
  elapsedSeconds: number;
  powerWatts?: number | null;
  heartRateBpm?: number | null;
  cadenceRpm?: number | null;
}

export interface CyclingWorkoutSettings {
  thresholdHeartRateBpm?: number | null;
  powerZoneUpperPcts?: number[] | null;
  heartRateZoneUpperPcts?: number[] | null;
}

export interface CyclingWorkoutIntervalInput {
  index: number;
  type: "work" | "recovery" | "warmup" | "cooldown" | "other";
  label?: string | null;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  targetPowerWatts?: number | null;
}

interface StreamCoverage {
  observedSamples: number;
  coveredSeconds: number;
  missingSeconds: number;
  zeroSeconds: number;
  coveragePct: number;
  medianSampleIntervalSeconds: number | null;
  largestGapSeconds: number | null;
}

interface ZoneDistribution {
  threshold: number;
  upperPcts: number[];
  zones: Array<{ zone: number; seconds: number; percent: number }>;
}

export interface CyclingWorkoutMetricsInput {
  durationSeconds: number;
  thresholdWatts: number | null;
  samples: CyclingWorkoutSample[];
  settings: CyclingWorkoutSettings | null;
  intervals: CyclingWorkoutIntervalInput[];
  streamBarriers?: { power?: number[]; heartRate?: number[]; cadence?: number[] };
}

export interface CyclingWorkoutPowerMetrics {
  normalizedPowerWatts: number | null;
  intensityFactor: number | null;
  trainingStressScore: number | null;
}

export interface CyclingWorkoutPowerWindow {
  samples: Array<{ elapsedSeconds: number; watts: number | null }>;
  durationSeconds: number;
  thresholdWatts: number | null;
}

export interface PreparedCyclingWorkoutMetrics {
  durationSeconds: number;
  thresholdWatts: number | null;
  settings: CyclingWorkoutSettings | null;
  power: ResampledStream;
  heartRate: ResampledStream;
  cadence: ResampledStream;
  intervalInputs: CyclingWorkoutIntervalInput[];
  intervalSource: CyclingWorkoutMetrics["intervalSource"];
  intervalDetection: CyclingWorkoutMetrics["intervalDetection"];
  powerWindows: CyclingWorkoutPowerWindow[];
}

export interface CyclingWorkoutMetrics {
  durationSeconds: number;
  power: {
    averageWatts: number | null;
    normalizedWatts: number | null;
    variabilityIndex: number | null;
    workKilojoules: number | null;
    intensityFactor: number | null;
    trainingStressScore: number | null;
  };
  heartRate: { averageBpm: number | null; maximumBpm: number | null };
  cadence: { averageRpm: number | null };
  aerobicEfficiency: {
    powerToHeartRateRatio: number | null;
    pairedSeconds: number;
  };
  cardiacDrift: {
    percent: number | null;
    firstHalfPowerToHeartRate: number | null;
    secondHalfPowerToHeartRate: number | null;
    pairedSeconds: number;
    method: "equal_elapsed_time_halves_power_to_heart_rate";
  };
  powerZones: ZoneDistribution | null;
  heartRateZones: ZoneDistribution | null;
  coverage: {
    power: StreamCoverage;
    heartRate: StreamCoverage;
    cadence: StreamCoverage;
  };
  intervalSource: "recorded" | "inferred" | "none";
  intervalDetection: {
    method: "30_second_average_above_105_percent_ftp";
    thresholdWatts: number;
    minimumWorkSeconds: number;
  } | null;
  intervals: Array<{
    index: number;
    type: CyclingWorkoutIntervalInput["type"];
    label: string | null;
    source: "recorded" | "inferred";
    startOffsetSeconds: number;
    endOffsetSeconds: number;
    durationSeconds: number;
    averagePowerWatts: number | null;
    normalizedPowerWatts: number | null;
    averageHeartRateBpm: number | null;
    averageCadenceRpm: number | null;
    targetPowerWatts: number | null;
    completionPct: number | null;
  }>;
  unavailableReasons: Array<{ metric: string; reason: string }>;
}

interface ResampledStream {
  values: Array<number | null>;
  maximumValue: number | null;
  coverage: StreamCoverage;
}

function round(value: number, decimals = 1): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function average(values: Array<number | null>): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (value == null) continue;
    total += value;
    count++;
  }
  return count === 0 ? null : total / count;
}

function resampleCyclingBuckets<T extends CyclingWorkoutSample>(
  samples: T[],
  durationSeconds: number,
  select: (sample: T) => number | null | undefined,
  minimumValue = 0,
  barriers: number[] = [],
) {
  const observations = samples.flatMap((sample) => {
    const value = select(sample);
    if (
      value === undefined ||
      !Number.isFinite(sample.elapsedSeconds) ||
      sample.elapsedSeconds < 0 ||
      sample.elapsedSeconds >= durationSeconds
    )
      return [];
    return [
      {
        elapsedSeconds: sample.elapsedSeconds,
        value: value === null || !Number.isFinite(value) || value < minimumValue ? null : value,
      },
    ];
  });
  observations.push(
    ...barriers
      .filter((offset) => Number.isFinite(offset) && offset >= 0 && offset < durationSeconds)
      .map((elapsedSeconds) => ({ elapsedSeconds, value: null })),
  );
  const valuesByOffset = new Map<number, number>();
  const conflicts = new Set<number>();
  for (const point of observations) {
    if (point.value === null) continue;
    const previous = valuesByOffset.get(point.elapsedSeconds);
    if (previous !== undefined && previous !== point.value) conflicts.add(point.elapsedSeconds);
    valuesByOffset.set(point.elapsedSeconds, point.value);
  }
  observations.push(...[...conflicts].map((elapsedSeconds) => ({ elapsedSeconds, value: null })));
  const stream = resampleSignal(observations, durationSeconds, cyclingPowerCoveragePolicy);
  return {
    ...stream,
    coverage: { ...stream.coverage, coveragePct: round(stream.coverage.coveragePct) },
  };
}

export function resampleCyclingStream<T extends CyclingWorkoutSample>(
  samples: T[],
  durationSeconds: number,
  select: (sample: T) => number | null | undefined,
  minimumValue = 0,
  barriers: number[] = [],
): ResampledStream {
  const stream = resampleCyclingBuckets(samples, durationSeconds, select, minimumValue, barriers);
  return {
    values: Array.from(
      { length: durationSeconds },
      (_, second) => stream.buckets.get(second)?.value ?? null,
    ),
    maximumValue: stream.maximumValue,
    coverage: stream.coverage,
  };
}

/** Sum covered power buckets without allocating or scanning missing elapsed seconds. */
export function computeCyclingPowerWork(
  samples: CyclingWorkoutSample[],
  durationSeconds: number,
  barriers: number[] = [],
): { workKilojoules: number | null; coverage: StreamCoverage } {
  const stream = resampleCyclingBuckets(
    samples,
    Math.max(0, Math.floor(durationSeconds)),
    (sample) => sample.powerWatts,
    0,
    barriers,
  );
  let totalJoules = 0;
  for (const bucket of stream.buckets.values()) totalJoules += bucket.value;
  return {
    workKilojoules: stream.coverage.coveredSeconds > 0 ? round(totalJoules / 1_000) : null,
    coverage: stream.coverage,
  };
}

function zoneDistribution(
  values: Array<number | null>,
  threshold: number | null | undefined,
  upperPcts: number[] | null | undefined,
): ZoneDistribution | null {
  if (threshold == null || threshold <= 0 || !upperPcts || upperPcts.length === 0) return null;
  const counts = Array.from({ length: upperPcts.length + 1 }, () => 0);
  for (const value of values) {
    if (value == null) continue;
    const zoneIndex = upperPcts.findIndex((upperPct) => value < threshold * upperPct);
    const resolvedIndex = zoneIndex === -1 ? counts.length - 1 : zoneIndex;
    counts[resolvedIndex] = (counts[resolvedIndex] ?? 0) + 1;
  }
  const total = counts.reduce((sum, seconds) => sum + seconds, 0);
  return {
    threshold,
    upperPcts: [...upperPcts],
    zones: counts.map((seconds, index) => ({
      zone: index + 1,
      seconds,
      percent: total > 0 ? round((seconds / total) * 100) : 0,
    })),
  };
}

function pairedEfficiency(
  power: Array<number | null>,
  heartRate: Array<number | null>,
  start = 0,
  end = power.length,
): { ratio: number | null; seconds: number } {
  let powerTotal = 0;
  let heartRateTotal = 0;
  let seconds = 0;
  for (let index = start; index < end; index++) {
    const watts = power[index];
    const bpm = heartRate[index];
    if (watts == null || bpm == null || bpm <= 0) continue;
    powerTotal += watts;
    heartRateTotal += bpm;
    seconds++;
  }
  return {
    ratio: seconds > 0 && heartRateTotal > 0 ? powerTotal / heartRateTotal : null,
    seconds,
  };
}

function intervalMetrics(
  interval: CyclingWorkoutIntervalInput,
  source: "recorded" | "inferred",
  power: Array<number | null>,
  heartRate: Array<number | null>,
  cadence: Array<number | null>,
  computedPower: CyclingWorkoutPowerMetrics,
) {
  const start = Math.max(0, Math.floor(interval.startOffsetSeconds));
  const end = Math.min(power.length, Math.ceil(interval.endOffsetSeconds));
  const powerSlice = power.slice(start, end);
  const averagePower = average(powerSlice);
  const targetPower = interval.targetPowerWatts ?? null;
  return {
    index: interval.index,
    type: interval.type,
    label: interval.label ?? null,
    source,
    startOffsetSeconds: start,
    endOffsetSeconds: end,
    durationSeconds: Math.max(0, end - start),
    averagePowerWatts: averagePower == null ? null : round(averagePower),
    normalizedPowerWatts: computedPower.normalizedPowerWatts,
    averageHeartRateBpm: (() => {
      const value = average(heartRate.slice(start, end));
      return value == null ? null : round(value);
    })(),
    averageCadenceRpm: (() => {
      const value = average(cadence.slice(start, end));
      return value == null ? null : round(value);
    })(),
    targetPowerWatts: targetPower,
    completionPct:
      targetPower != null && targetPower > 0 && averagePower != null
        ? round((averagePower / targetPower) * 100)
        : null,
  };
}

function detectIntervals(
  power: Array<number | null>,
  threshold: number | null,
): { intervals: CyclingWorkoutIntervalInput[]; thresholdWatts: number } | null {
  if (threshold == null || threshold <= 0 || power.length < 30) return null;
  const thresholdWatts = threshold * 1.05;
  const candidates: Array<{ start: number; end: number }> = [];
  let start: number | null = null;

  for (let index = 0; index <= power.length; index++) {
    const isWork =
      index < power.length && power[index] != null && (power[index] ?? 0) >= thresholdWatts;
    if (isWork && start == null) start = index;
    if ((!isWork || index === power.length) && start != null) {
      const previous = candidates.at(-1);
      if (previous && start - previous.end < 15) previous.end = index;
      else candidates.push({ start, end: index });
      start = null;
    }
  }

  const workIntervals = candidates.filter((candidate) => {
    if (candidate.end - candidate.start < 30) return false;
    let rollingTotal = 0;
    let rollingCount = 0;
    for (let index = candidate.start; index < candidate.end; index++) {
      const watts = power[index];
      if (watts != null) {
        rollingTotal += watts;
        rollingCount++;
      }
      if (index - candidate.start >= 30) {
        const expired = power[index - 30];
        if (expired != null) {
          rollingTotal -= expired;
          rollingCount--;
        }
      }
      if (rollingCount === 30 && rollingTotal / 30 >= thresholdWatts) return true;
    }
    return false;
  });
  if (workIntervals.length === 0) return null;

  const intervals: CyclingWorkoutIntervalInput[] = [];
  for (let index = 0; index < workIntervals.length; index++) {
    const work = workIntervals[index];
    if (!work) continue;
    intervals.push({
      index: intervals.length + 1,
      type: "work",
      label: null,
      startOffsetSeconds: work.start,
      endOffsetSeconds: work.end,
      targetPowerWatts: null,
    });
    const next = workIntervals[index + 1];
    if (next && next.start > work.end) {
      intervals.push({
        index: intervals.length + 1,
        type: "recovery",
        label: null,
        startOffsetSeconds: work.end,
        endOffsetSeconds: next.start,
        targetPowerWatts: null,
      });
    }
  }
  return { intervals, thresholdWatts };
}

/**
 * Compute per-activity cycling metrics from native samples without extrapolating
 * through dropouts. Every coverage field is expressed against elapsed duration.
 */
export function prepareCyclingWorkoutMetrics(
  input: CyclingWorkoutMetricsInput,
): PreparedCyclingWorkoutMetrics {
  const durationSeconds = Math.max(0, Math.floor(input.durationSeconds));
  const power = resampleCyclingStream(
    input.samples,
    durationSeconds,
    (sample) => sample.powerWatts,
    0,
    input.streamBarriers?.power,
  );
  const heartRate = resampleCyclingStream(
    input.samples,
    durationSeconds,
    (sample) => sample.heartRateBpm,
    0,
    input.streamBarriers?.heartRate,
  );
  const cadence = resampleCyclingStream(
    input.samples,
    durationSeconds,
    (sample) => sample.cadenceRpm,
    0,
    input.streamBarriers?.cadence,
  );
  const thresholdWatts =
    input.thresholdWatts != null &&
    Number.isFinite(input.thresholdWatts) &&
    input.thresholdWatts > 0
      ? input.thresholdWatts
      : null;
  const detected =
    input.intervals.length === 0 ? detectIntervals(power.values, thresholdWatts) : null;
  const intervalInputs = input.intervals.length > 0 ? input.intervals : (detected?.intervals ?? []);
  const intervalSource =
    input.intervals.length > 0
      ? "recorded"
      : detected && detected.intervals.length > 0
        ? "inferred"
        : "none";
  return {
    durationSeconds,
    thresholdWatts,
    settings: input.settings,
    power,
    heartRate,
    cadence,
    intervalInputs,
    intervalSource,
    intervalDetection:
      detected == null
        ? null
        : {
            method: "30_second_average_above_105_percent_ftp",
            thresholdWatts: detected.thresholdWatts,
            minimumWorkSeconds: 30,
          },
    powerWindows: intervalInputs.map((interval) => {
      const start = Math.max(0, Math.floor(interval.startOffsetSeconds));
      const end = Math.min(durationSeconds, Math.ceil(interval.endOffsetSeconds));
      return {
        samples: power.values
          .slice(start, end)
          .map((watts, elapsedSeconds) => ({ elapsedSeconds, watts })),
        durationSeconds: Math.max(0, end - start),
        thresholdWatts,
      };
    }),
  };
}

/** Assemble workout metrics using required externally evaluated power calculations. */
export function computeCyclingWorkoutMetrics(
  input: PreparedCyclingWorkoutMetrics,
  computed: {
    activity: CyclingWorkoutPowerMetrics;
    intervals: readonly CyclingWorkoutPowerMetrics[];
  },
): CyclingWorkoutMetrics {
  if (computed.intervals.length !== input.intervalInputs.length) {
    throw new Error("Every prepared interval requires computed power metrics");
  }
  const { durationSeconds, power, heartRate, cadence, intervalInputs, intervalSource } = input;
  const unavailableReasons: CyclingWorkoutMetrics["unavailableReasons"] = [];
  const addUnavailable = (metric: string, reason: string) => {
    unavailableReasons.push({ metric, reason });
  };

  const averagePower = average(power.values);
  const normalizedPower = computed.activity.normalizedPowerWatts;
  if (normalizedPower == null) {
    addUnavailable(
      "normalized_power",
      power.coverage.coveragePct < 90
        ? "power coverage is below 90%"
        : power.coverage.missingSeconds > 0
          ? "power samples contain missing elapsed seconds"
          : durationSeconds < 30
            ? "fewer than 30 seconds of power are available"
            : "computed normalized power is unavailable",
    );
  }
  const validFtp = input.thresholdWatts;
  if (validFtp == null) {
    addUnavailable("intensity_factor", "no computed threshold is available for this activity");
    addUnavailable("training_stress_score", "no computed threshold is available for this activity");
  } else if (normalizedPower == null) {
    addUnavailable("intensity_factor", "normalized power is unavailable");
    addUnavailable("training_stress_score", "normalized power is unavailable");
  }

  const averageHeartRate = average(heartRate.values);
  if (averageHeartRate == null) addUnavailable("heart_rate", "no heart-rate samples are available");
  const averageCadence = average(cadence.values);
  if (averageCadence == null) addUnavailable("cadence", "no cadence samples are available");

  const efficiency = pairedEfficiency(power.values, heartRate.values);
  if (efficiency.ratio == null) {
    addUnavailable(
      "aerobic_efficiency",
      "no synchronized power and heart-rate samples are available",
    );
  }

  const midpoint = Math.floor(durationSeconds / 2);
  const firstHalf = pairedEfficiency(power.values, heartRate.values, 0, midpoint);
  const secondHalf = pairedEfficiency(power.values, heartRate.values, midpoint, durationSeconds);
  const driftCoverageRequired = midpoint * 0.9;
  const driftAvailable =
    durationSeconds >= 1_200 &&
    firstHalf.ratio != null &&
    secondHalf.ratio != null &&
    firstHalf.seconds >= driftCoverageRequired &&
    secondHalf.seconds >= (durationSeconds - midpoint) * 0.9;
  if (!driftAvailable) {
    addUnavailable(
      "cardiac_drift",
      durationSeconds < 1_200
        ? "activity is shorter than 20 minutes"
        : "paired power and heart-rate coverage is below 90% in one or both halves",
    );
  }

  return {
    durationSeconds,
    power: {
      averageWatts: averagePower == null ? null : round(averagePower),
      normalizedWatts: normalizedPower,
      variabilityIndex:
        normalizedPower != null && averagePower != null && averagePower > 0
          ? round(normalizedPower / averagePower, 3)
          : null,
      workKilojoules:
        averagePower == null
          ? null
          : round(power.values.reduce<number>((total, watts) => total + (watts ?? 0), 0) / 1_000),
      intensityFactor: computed.activity.intensityFactor,
      trainingStressScore: computed.activity.trainingStressScore,
    },
    heartRate: {
      averageBpm: averageHeartRate == null ? null : round(averageHeartRate),
      maximumBpm: heartRate.maximumValue,
    },
    cadence: { averageRpm: averageCadence == null ? null : round(averageCadence) },
    aerobicEfficiency: {
      powerToHeartRateRatio: efficiency.ratio == null ? null : round(efficiency.ratio, 3),
      pairedSeconds: efficiency.seconds,
    },
    cardiacDrift: {
      percent:
        driftAvailable && firstHalf.ratio != null && secondHalf.ratio != null
          ? round(((firstHalf.ratio - secondHalf.ratio) / firstHalf.ratio) * 100)
          : null,
      firstHalfPowerToHeartRate:
        driftAvailable && firstHalf.ratio != null ? round(firstHalf.ratio, 3) : null,
      secondHalfPowerToHeartRate:
        driftAvailable && secondHalf.ratio != null ? round(secondHalf.ratio, 3) : null,
      pairedSeconds: driftAvailable ? firstHalf.seconds + secondHalf.seconds : 0,
      method: "equal_elapsed_time_halves_power_to_heart_rate",
    },
    powerZones: zoneDistribution(power.values, validFtp, input.settings?.powerZoneUpperPcts),
    heartRateZones: zoneDistribution(
      heartRate.values,
      input.settings?.thresholdHeartRateBpm,
      input.settings?.heartRateZoneUpperPcts,
    ),
    coverage: {
      power: power.coverage,
      heartRate: heartRate.coverage,
      cadence: cadence.coverage,
    },
    intervalSource,
    intervalDetection: input.intervalDetection,
    intervals: intervalInputs.map((interval, ordinal) => {
      const intervalPower = computed.intervals[ordinal];
      if (!intervalPower)
        throw new Error("Every prepared interval requires computed power metrics");
      return intervalMetrics(
        interval,
        intervalSource === "recorded" ? "recorded" : "inferred",
        power.values,
        heartRate.values,
        cadence.values,
        intervalPower,
      );
    }),
    unavailableReasons,
  };
}
