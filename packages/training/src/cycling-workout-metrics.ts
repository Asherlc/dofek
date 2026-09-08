import { computePowerTss } from "./pmc.ts";
import { computeNormalizedPower } from "./power-analysis.ts";

export interface CyclingWorkoutSample {
  elapsedSeconds: number;
  powerWatts?: number | null;
  heartRateBpm?: number | null;
  cadenceRpm?: number | null;
}

export interface CyclingWorkoutSettings {
  ftpWatts?: number | null;
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
  samples: CyclingWorkoutSample[];
  settings: CyclingWorkoutSettings | null;
  intervals: CyclingWorkoutIntervalInput[];
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (upper == null) return null;
  return sorted.length % 2 === 0 && lower != null ? (lower + upper) / 2 : upper;
}

function resampleStream(
  samples: CyclingWorkoutSample[],
  durationSeconds: number,
  select: (sample: CyclingWorkoutSample) => number | null | undefined,
): ResampledStream {
  const byOffset = new Map<number, number>();
  for (const sample of samples) {
    const value = select(sample);
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    const offset = Math.floor(sample.elapsedSeconds);
    if (offset >= 0 && offset < durationSeconds) byOffset.set(offset, value);
  }
  const points = [...byOffset.entries()]
    .map(([offset, value]) => ({ offset, value }))
    .sort((left, right) => left.offset - right.offset);
  const gaps = points.slice(1).map((point, index) => point.offset - (points[index]?.offset ?? 0));
  const medianInterval = median(gaps);
  const nativeInterval = medianInterval ?? 1;
  const continuityTolerance = Math.min(10, Math.max(5, nativeInterval * 2));
  const values: Array<number | null> = Array.from({ length: durationSeconds }, () => null);

  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) continue;
    const next = points[index + 1];
    const intervalEnd = next
      ? next.offset - point.offset <= continuityTolerance
        ? next.offset
        : point.offset + nativeInterval
      : point.offset + nativeInterval;
    for (let second = point.offset; second < Math.min(durationSeconds, intervalEnd); second++) {
      values[second] = point.value;
    }
  }

  const coveredSeconds = values.reduce<number>(
    (count, value) => count + (value == null ? 0 : 1),
    0,
  );
  const zeroSeconds = values.reduce<number>((count, value) => count + (value === 0 ? 1 : 0), 0);
  return {
    values,
    coverage: {
      observedSamples: points.length,
      coveredSeconds,
      missingSeconds: durationSeconds - coveredSeconds,
      zeroSeconds,
      coveragePct: durationSeconds > 0 ? round((coveredSeconds / durationSeconds) * 100) : 0,
      medianSampleIntervalSeconds: medianInterval,
      largestGapSeconds: gaps.length > 0 ? Math.max(...gaps) : null,
    },
  };
}

function computeNormalizedWatts(values: Array<number | null>): number | null {
  if (values.length < 30 || values.some((value) => value == null)) return null;
  const result = computeNormalizedPower(
    values.map((power, index) => ({
      activity_id: "activity",
      activity_date: "1970-01-01",
      activity_name: null,
      power: power ?? 0,
      interval_s: 1,
      index,
    })),
  );
  return result[0]?.normalizedPower ?? null;
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
) {
  const start = Math.max(0, Math.floor(interval.startOffsetSeconds));
  const end = Math.min(power.length, Math.ceil(interval.endOffsetSeconds));
  const powerSlice = power.slice(start, end);
  const averagePower = average(powerSlice);
  const normalizedPower = computeNormalizedWatts(powerSlice);
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
    normalizedPowerWatts: normalizedPower,
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
  ftpWatts: number | null,
): { intervals: CyclingWorkoutIntervalInput[]; thresholdWatts: number } | null {
  if (ftpWatts == null || ftpWatts <= 0 || power.length < 30) return null;
  const thresholdWatts = ftpWatts * 1.05;
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
export function computeCyclingWorkoutMetrics(
  input: CyclingWorkoutMetricsInput,
): CyclingWorkoutMetrics {
  const durationSeconds = Math.max(0, Math.floor(input.durationSeconds));
  const power = resampleStream(input.samples, durationSeconds, (sample) => sample.powerWatts);
  const heartRate = resampleStream(input.samples, durationSeconds, (sample) => sample.heartRateBpm);
  const cadence = resampleStream(input.samples, durationSeconds, (sample) => sample.cadenceRpm);
  const unavailableReasons: CyclingWorkoutMetrics["unavailableReasons"] = [];
  const addUnavailable = (metric: string, reason: string) => {
    unavailableReasons.push({ metric, reason });
  };

  const averagePower = average(power.values);
  const normalizedPower = computeNormalizedWatts(power.values);
  if (normalizedPower == null) {
    addUnavailable(
      "normalized_power",
      power.coverage.coveragePct < 90
        ? "power coverage is below 90%"
        : power.coverage.missingSeconds > 0
          ? "power samples contain missing elapsed seconds"
          : "fewer than 30 seconds of power are available",
    );
  }
  const ftpWatts = input.settings?.ftpWatts;
  const validFtp = ftpWatts != null && Number.isFinite(ftpWatts) && ftpWatts > 0 ? ftpWatts : null;
  if (validFtp == null) {
    addUnavailable("intensity_factor", "no valid FTP was effective for this activity");
    addUnavailable("training_stress_score", "no valid FTP was effective for this activity");
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

  const detected = input.intervals.length === 0 ? detectIntervals(power.values, validFtp) : null;
  const intervalInputs = input.intervals.length > 0 ? input.intervals : (detected?.intervals ?? []);
  const intervalSource =
    input.intervals.length > 0
      ? "recorded"
      : detected && detected.intervals.length > 0
        ? "inferred"
        : "none";

  const intensityFactor =
    validFtp != null && normalizedPower != null ? normalizedPower / validFtp : null;
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
      intensityFactor: intensityFactor == null ? null : round(intensityFactor, 3),
      trainingStressScore:
        validFtp != null && normalizedPower != null
          ? round(computePowerTss(normalizedPower, validFtp, durationSeconds / 60))
          : null,
    },
    heartRate: {
      averageBpm: averageHeartRate == null ? null : round(averageHeartRate),
      maximumBpm:
        heartRate.coverage.coveredSeconds === 0
          ? null
          : Math.max(...heartRate.values.flatMap((value) => (value == null ? [] : [value]))),
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
    intervalDetection:
      detected == null
        ? null
        : {
            method: "30_second_average_above_105_percent_ftp",
            thresholdWatts: detected.thresholdWatts,
            minimumWorkSeconds: 30,
          },
    intervals: intervalInputs.map((interval) =>
      intervalMetrics(
        interval,
        intervalSource === "recorded" ? "recorded" : "inferred",
        power.values,
        heartRate.values,
        cadence.values,
      ),
    ),
    unavailableReasons,
  };
}
