export const activityTimeseriesStreams = [
  "power",
  "heart_rate",
  "cadence",
  "speed",
  "distance",
  "altitude",
  "grade",
  "position",
  "temperature",
  "elapsed_time",
  "moving_time",
] as const;

export type ActivityTimeseriesStream = (typeof activityTimeseriesStreams)[number];
export type NativeActivityTimeseriesStream = Exclude<ActivityTimeseriesStream, "elapsed_time">;
export type TimeseriesResolution = "raw" | "1s" | "5s" | "10s" | "30s" | "60s";
export type TimeseriesFill = "none" | "linear";
export type ActivityTimeseriesValue = number | [number, number] | null;
export type ActivityTimeseriesState =
  | "measured"
  | "measured_zero"
  | "aggregated"
  | "aggregated_zero"
  | "calculated"
  | "calculated_zero"
  | "interpolated"
  | "missing";

export interface NativeActivityTimeseriesSample {
  recordedAt: string;
  stream: NativeActivityTimeseriesStream;
  value: Exclude<ActivityTimeseriesValue, null>;
  sourceIndex: number;
}

export interface ActivityTimeseriesSummary {
  min: number | null;
  max: number | null;
  average: number | null;
  observedSamples: number;
  missingPoints: number;
  zeroPoints: number;
  largestGapSeconds: number | null;
}

export interface ActivityTimeseriesColumn {
  values: ActivityTimeseriesValue[];
  states: ActivityTimeseriesState[];
  sourceIndexes: Array<number[] | null>;
  unit: string;
  summary: ActivityTimeseriesSummary;
  availabilityReason: string | null;
}

export interface SynchronizedActivityTimeseries {
  timestamps: string[];
  offsetsSeconds: number[];
  streams: Partial<Record<ActivityTimeseriesStream, ActivityTimeseriesColumn>>;
  effectiveResolutionSeconds: number | null;
}

export interface SynchronizeActivityTimeseriesInput {
  startedAt: string;
  endedAt: string | null;
  rangeStartedAt?: string;
  streams: readonly ActivityTimeseriesStream[];
  resolution: TimeseriesResolution;
  fill: TimeseriesFill;
  samples: readonly NativeActivityTimeseriesSample[];
}

const resolutionSeconds: Record<Exclude<TimeseriesResolution, "raw">, number> = {
  "1s": 1,
  "5s": 5,
  "10s": 10,
  "30s": 30,
  "60s": 60,
};

const units: Record<ActivityTimeseriesStream, string> = {
  power: "W",
  heart_rate: "bpm",
  cadence: "rpm",
  speed: "m/s",
  distance: "m",
  altitude: "m",
  grade: "%",
  position: "degrees",
  temperature: "°C",
  elapsed_time: "s",
  moving_time: "s",
};

const cumulativeStreams = new Set<ActivityTimeseriesStream>(["distance"]);

function milliseconds(timestamp: string): number {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error(`Invalid activity sample timestamp: ${timestamp}`);
  return value;
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function largestGapSeconds(samples: readonly NativeActivityTimeseriesSample[]): number | null {
  const timestamps = uniqueSorted(samples.map((sample) => milliseconds(sample.recordedAt)));
  if (timestamps.length < 2) return null;
  let largest = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    largest = Math.max(largest, ((timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0)) / 1_000);
  }
  return largest;
}

function summarize(
  values: readonly ActivityTimeseriesValue[],
  samples: readonly NativeActivityTimeseriesSample[],
): ActivityTimeseriesSummary {
  const numericValues = values.filter((value): value is number => typeof value === "number");
  return {
    min: numericValues.length > 0 ? Math.min(...numericValues) : null,
    max: numericValues.length > 0 ? Math.max(...numericValues) : null,
    average:
      numericValues.length > 0
        ? numericValues.reduce((total, value) => total + value, 0) / numericValues.length
        : null,
    observedSamples: samples.length,
    missingPoints: values.filter((value) => value === null).length,
    zeroPoints: numericValues.filter((value) => value === 0).length,
    largestGapSeconds: largestGapSeconds(samples),
  };
}

function rawColumn(
  stream: ActivityTimeseriesStream,
  timestampsMs: readonly number[],
  samples: readonly NativeActivityTimeseriesSample[],
): ActivityTimeseriesColumn {
  const sampleByTimestamp = new Map(
    samples.map((sample) => [milliseconds(sample.recordedAt), sample]),
  );
  const values = timestampsMs.map((timestamp) => sampleByTimestamp.get(timestamp)?.value ?? null);
  return {
    values,
    states: values.map((value) =>
      value === null ? "missing" : value === 0 ? "measured_zero" : "measured",
    ),
    sourceIndexes: timestampsMs.map((timestamp) => {
      const sample = sampleByTimestamp.get(timestamp);
      return sample ? [sample.sourceIndex] : null;
    }),
    unit: units[stream],
    summary: summarize(values, samples),
    availabilityReason: null,
  };
}

function bucketValue(
  stream: ActivityTimeseriesStream,
  bucketSamples: readonly NativeActivityTimeseriesSample[],
  bucketEndMs: number,
): Exclude<ActivityTimeseriesValue, null> {
  const ordered = [...bucketSamples].sort(
    (left, right) => milliseconds(left.recordedAt) - milliseconds(right.recordedAt),
  );
  const last = ordered.at(-1);
  if (!last) throw new Error("Cannot aggregate an empty activity time-series bucket");
  if (stream === "position" || cumulativeStreams.has(stream)) return last.value;

  let weightedTotal = 0;
  let observedMilliseconds = 0;
  for (const [index, sample] of ordered.entries()) {
    if (typeof sample.value !== "number") continue;
    const sampleMs = milliseconds(sample.recordedAt);
    const nextMs = ordered[index + 1]
      ? milliseconds(ordered[index + 1]?.recordedAt ?? sample.recordedAt)
      : bucketEndMs;
    const duration = Math.max(0, nextMs - sampleMs);
    weightedTotal += sample.value * duration;
    observedMilliseconds += duration;
  }
  return observedMilliseconds > 0 && typeof last.value === "number"
    ? weightedTotal / observedMilliseconds
    : last.value;
}

function fillInternalScalarGaps(column: ActivityTimeseriesColumn): void {
  for (let index = 0; index < column.values.length; index += 1) {
    if (column.values[index] !== null) continue;
    let previousIndex = index - 1;
    while (previousIndex >= 0 && column.values[previousIndex] === null) previousIndex -= 1;
    let nextIndex = index + 1;
    while (nextIndex < column.values.length && column.values[nextIndex] === null) nextIndex += 1;
    const previousValue = column.values[previousIndex];
    const nextValue = column.values[nextIndex];
    if (typeof previousValue !== "number" || typeof nextValue !== "number") continue;
    const fraction = (index - previousIndex) / (nextIndex - previousIndex);
    column.values[index] = previousValue + (nextValue - previousValue) * fraction;
    column.states[index] = "interpolated";
  }
}

function fixedColumn(
  stream: ActivityTimeseriesStream,
  timestampsMs: readonly number[],
  bucketSeconds: number,
  samples: readonly NativeActivityTimeseriesSample[],
  fill: TimeseriesFill,
): ActivityTimeseriesColumn {
  const bucketMilliseconds = bucketSeconds * 1_000;
  const values: ActivityTimeseriesValue[] = [];
  const sourceIndexes: Array<number[] | null> = [];
  for (const bucketStart of timestampsMs) {
    const bucketSamples = samples.filter((sample) => {
      const sampleMs = milliseconds(sample.recordedAt);
      return sampleMs >= bucketStart && sampleMs < bucketStart + bucketMilliseconds;
    });
    values.push(
      bucketSamples.length > 0
        ? bucketValue(stream, bucketSamples, bucketStart + bucketMilliseconds)
        : null,
    );
    sourceIndexes.push(
      bucketSamples.length > 0
        ? uniqueSorted(bucketSamples.map((sample) => sample.sourceIndex))
        : null,
    );
  }
  const column: ActivityTimeseriesColumn = {
    values,
    states: values.map((value) =>
      value === null ? "missing" : value === 0 ? "aggregated_zero" : "aggregated",
    ),
    sourceIndexes,
    unit: units[stream],
    summary: summarize(values, samples),
    availabilityReason: null,
  };
  if (fill === "linear" && stream !== "position" && !cumulativeStreams.has(stream)) {
    fillInternalScalarGaps(column);
    column.summary = summarize(column.values, samples);
  }
  return column;
}

function calculatedColumn(
  stream: "elapsed_time" | "moving_time",
  values: Array<number | null>,
  observedSamples: readonly NativeActivityTimeseriesSample[],
  availabilityReason: string | null,
  sourceIndexes: number[] = [],
): ActivityTimeseriesColumn {
  return {
    values,
    states: values.map((value) =>
      value === null ? "missing" : value === 0 ? "calculated_zero" : "calculated",
    ),
    sourceIndexes: values.map((value) =>
      value === null || sourceIndexes.length === 0 ? null : sourceIndexes,
    ),
    unit: units[stream],
    summary: summarize(values, observedSamples),
    availabilityReason,
  };
}

function speedDerivedMovingTime(
  timestampsMs: readonly number[],
  startedAtMs: number,
  speedSamples: readonly NativeActivityTimeseriesSample[],
): Array<number | null> {
  if (speedSamples.length === 0) return timestampsMs.map(() => null);
  const orderedSpeed = [...speedSamples].sort(
    (left, right) => milliseconds(left.recordedAt) - milliseconds(right.recordedAt),
  );
  let speedIndex = 0;
  let previousTimestamp = startedAtMs;
  let currentSpeed: number | null = null;
  let movingSeconds = 0;
  return timestampsMs.map((timestamp) => {
    while (
      speedIndex < orderedSpeed.length &&
      milliseconds(orderedSpeed[speedIndex]?.recordedAt ?? "") <= timestamp
    ) {
      const speedSample = orderedSpeed[speedIndex];
      if (!speedSample || typeof speedSample.value !== "number") {
        speedIndex += 1;
        continue;
      }
      const sampleTimestamp = milliseconds(speedSample.recordedAt);
      if (currentSpeed !== null && sampleTimestamp > previousTimestamp && currentSpeed > 0) {
        movingSeconds += (sampleTimestamp - previousTimestamp) / 1_000;
      }
      previousTimestamp = sampleTimestamp;
      currentSpeed = speedSample.value;
      speedIndex += 1;
    }
    if (currentSpeed !== null && timestamp > previousTimestamp && currentSpeed > 0) {
      movingSeconds += (timestamp - previousTimestamp) / 1_000;
    }
    previousTimestamp = timestamp;
    return movingSeconds;
  });
}

export function synchronizeActivityTimeseries(
  input: SynchronizeActivityTimeseriesInput,
): SynchronizedActivityTimeseries {
  const startedAtMs = milliseconds(input.startedAt);
  const rangeStartedAtMs = input.rangeStartedAt ? milliseconds(input.rangeStartedAt) : startedAtMs;
  const endedAtMs = input.endedAt ? milliseconds(input.endedAt) : null;
  const requestedStreams = [...new Set(input.streams)];
  const sampleStreams = new Set<ActivityTimeseriesStream>(requestedStreams);
  if (sampleStreams.has("moving_time")) sampleStreams.add("speed");
  const samples = input.samples.filter((sample) => sampleStreams.has(sample.stream));
  const rangeSamples = samples.filter((sample) => {
    const sampleMs = milliseconds(sample.recordedAt);
    return sampleMs >= rangeStartedAtMs && (endedAtMs === null || sampleMs < endedAtMs);
  });
  const bucketSeconds = input.resolution === "raw" ? null : resolutionSeconds[input.resolution];
  const timestampsMs =
    bucketSeconds === null
      ? uniqueSorted(rangeSamples.map((sample) => milliseconds(sample.recordedAt)))
      : Array.from(
          {
            length:
              endedAtMs !== null && endedAtMs > rangeStartedAtMs
                ? Math.ceil((endedAtMs - rangeStartedAtMs) / (bucketSeconds * 1_000))
                : 0,
          },
          (_, index) => rangeStartedAtMs + index * bucketSeconds * 1_000,
        );

  const streams: Partial<Record<ActivityTimeseriesStream, ActivityTimeseriesColumn>> = {};
  for (const stream of requestedStreams) {
    const streamSamples = rangeSamples.filter((sample) => sample.stream === stream);
    if (stream === "elapsed_time") {
      streams[stream] = calculatedColumn(
        stream,
        timestampsMs.map((timestamp) => (timestamp - startedAtMs) / 1_000),
        [],
        null,
      );
      continue;
    }
    if (stream === "moving_time" && streamSamples.length === 0) {
      const speedSamples = samples.filter((sample) => sample.stream === "speed");
      streams[stream] = calculatedColumn(
        stream,
        speedDerivedMovingTime(timestampsMs, startedAtMs, speedSamples),
        speedSamples,
        speedSamples.length > 0
          ? null
          : "Moving time requires provider-recorded moving time or speed samples.",
        uniqueSorted(speedSamples.map((sample) => sample.sourceIndex)),
      );
      continue;
    }
    streams[stream] =
      bucketSeconds === null
        ? rawColumn(stream, timestampsMs, streamSamples)
        : fixedColumn(stream, timestampsMs, bucketSeconds, streamSamples, input.fill);
  }

  return {
    timestamps: timestampsMs.map((timestamp) => new Date(timestamp).toISOString()),
    offsetsSeconds: timestampsMs.map((timestamp) => (timestamp - startedAtMs) / 1_000),
    streams,
    effectiveResolutionSeconds: bucketSeconds,
  };
}
