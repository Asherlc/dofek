export interface ActivityChartSample {
  recordedAt: string;
  value: number | null;
}

export interface ActivityChartWindow {
  startedAt: string;
  endedAt: string | null;
}

interface ChartObservation {
  /** Index in the API timeline, retained for map synchronization. */
  index: number;
  timestamp: number;
  value: number;
  position: number;
  startsSegment: boolean;
  showMarker: boolean;
}

export interface ActivityChartSeries {
  startedAt: number;
  endedAt: number;
  samples: ChartObservation[];
}

/**
 * Presentation geometry only: measurements are neither filled nor averaged.
 * Infer continuity from this metric's lower-median positive interval, allowing
 * 50% timing variation. At least two positive intervals are needed to infer a
 * cadence; otherwise observations remain dots. Sparse series retain markers.
 */
export function activityChartSeries(
  data: readonly ActivityChartSample[],
  activityWindow?: ActivityChartWindow,
): ActivityChartSeries {
  const timeline = data.map((sample, index) => ({
    ...sample,
    index,
    timestamp: Date.parse(sample.recordedAt),
  }));
  const times = timeline.map(({ timestamp }) => timestamp);
  let startedAt = activityWindow
    ? Date.parse(activityWindow.startedAt)
    : times.length > 0
      ? Math.min(...times)
      : 0;
  let endedAt = activityWindow?.endedAt
    ? Date.parse(activityWindow.endedAt)
    : times.length > 0
      ? Math.max(...times)
      : startedAt;
  if (startedAt === endedAt) {
    startedAt -= 500;
    endedAt += 500;
  }
  const observations = timeline
    .filter((sample): sample is typeof sample & { value: number } => sample.value !== null)
    .sort((left, right) => left.timestamp - right.timestamp);
  const intervals = observations
    .slice(1)
    .map((sample, index) => sample.timestamp - (observations[index]?.timestamp ?? sample.timestamp))
    .filter((interval) => interval > 0)
    .sort((left, right) => left - right);
  const typicalInterval = intervals[Math.floor((intervals.length - 1) / 2)] ?? 0;
  const gapLimit = intervals.length >= 2 ? typicalInterval * 1.5 : 0;
  const startsSegment = observations.map((sample, index) => {
    const previous = observations[index - 1];
    return !previous || sample.timestamp - previous.timestamp > gapLimit;
  });
  return {
    startedAt,
    endedAt,
    samples: observations.map((sample, index) => ({
      index: sample.index,
      timestamp: sample.timestamp,
      value: sample.value,
      position: (sample.timestamp - startedAt) / (endedAt - startedAt),
      startsSegment: startsSegment[index] === true,
      showMarker:
        observations.length <= 20 ||
        (startsSegment[index] === true &&
          (index === observations.length - 1 || startsSegment[index + 1] === true)),
    })),
  };
}

export function nearestActivityChartSample<T extends { timestamp: number }>(
  samples: readonly T[],
  timestamp: number,
): T | null {
  let nearest: T | null = null;
  for (const sample of samples) {
    if (
      !nearest ||
      Math.abs(sample.timestamp - timestamp) < Math.abs(nearest.timestamp - timestamp)
    ) {
      nearest = sample;
    }
  }
  return nearest;
}
