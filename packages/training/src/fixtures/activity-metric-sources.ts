/** Illustrative server-shaped recordings for the web and mobile Storybook previews. */
const startedAt = Date.parse("2026-10-18T17:30:00Z");
const timestamps = Array.from({ length: 121 }, (_, minute) =>
  new Date(startedAt + minute * 60_000).toISOString(),
);

export type ActivityPreviewMetric = "heartRate" | "power" | "speed" | "cadence" | "altitude";

interface PreviewSource {
  id: string;
  label: string;
  sourceLabel: string;
  attribution: string;
  values: Array<number | null>;
}

interface PreviewMetric {
  key: ActivityPreviewMetric;
  label: string;
  unit: string;
  sources: PreviewSource[];
}

function recording(valueAtMinute: (minute: number) => number | null) {
  return timestamps.map((_, minute) => valueAtMinute(minute));
}

const zepp = recording((minute) =>
  minute >= 44 && minute <= 46
    ? null
    : Math.round(142 + Math.sin(minute / 9) * 14 + Math.sin(minute / 3) * 4),
);
const whoop = recording((minute) =>
  minute >= 56 && minute <= 60
    ? null
    : Math.round(149 + Math.sin(minute / 9) * 18 + Math.sin(minute / 17) * 5),
);
const appleWatch = recording((minute) =>
  Math.round(145 + Math.sin(minute / 9) * 15 + Math.cos(minute / 7) * 4),
);

export const activityMetricSourcePreview: PreviewMetric[] = [
  {
    key: "heartRate",
    label: "Heart rate",
    unit: "bpm",
    sources: [
      {
        id: "zepp",
        label: "Zepp via Apple Health",
        sourceLabel: "Zepp via Apple Health",
        attribution: "Matched by recording time",
        values: zepp,
      },
      {
        id: "whoop",
        label: "WHOOP",
        sourceLabel: "WHOOP",
        attribution: "Recorded with this activity",
        values: whoop,
      },
      {
        id: "apple-watch",
        label: "Apple Watch via Apple Health",
        sourceLabel: "Apple Watch via Apple Health",
        attribution: "Matched by recording time",
        values: appleWatch,
      },
    ],
  },
  {
    key: "power",
    label: "Power",
    unit: "W",
    sources: ["Wahoo", "Garmin"].map((provider, index) => ({
      id: provider.toLowerCase(),
      label: provider,
      sourceLabel: provider,
      attribution: "Recorded with this activity",
      values: recording((minute) =>
        minute % 23 >= 20
          ? 0
          : Math.round(185 + Math.sin(minute / 8) * 65 + Math.sin(minute / 2) * 20 + index * 14),
      ),
    })),
  },
  {
    key: "speed",
    label: "Speed",
    unit: "km/h",
    sources: ["Wahoo", "Garmin", "Strava"].map((provider, index) => ({
      id: provider.toLowerCase(),
      label: provider,
      sourceLabel: provider,
      attribution: "Recorded with this activity",
      values: recording((minute) =>
        Number(
          (8.2 + Math.sin(minute / 11) * 2.1 + Math.cos(minute / 4) * 0.5 + index * 0.3).toFixed(2),
        ),
      ),
    })),
  },
  {
    key: "cadence",
    label: "Cadence",
    unit: "rpm",
    sources: ["Wahoo", "Garmin"].map((provider, index) => ({
      id: provider.toLowerCase(),
      label: provider,
      sourceLabel: provider,
      attribution: "Recorded with this activity",
      values: recording((minute) =>
        minute % 23 >= 20 ? 0 : Math.round(82 + Math.sin(minute / 6) * 9 + index * 4),
      ),
    })),
  },
  {
    key: "altitude",
    label: "Elevation",
    unit: "m",
    sources: ["Garmin", "Wahoo"].map((provider, index) => ({
      id: provider.toLowerCase(),
      label: provider,
      sourceLabel: provider,
      attribution: "Recorded with this activity",
      values: recording((minute) =>
        Math.round(230 + Math.sin(minute / 25) * 95 + minute * 0.8 + index * 8),
      ),
    })),
  },
];

export const defaultActivityMetricSources: Record<ActivityPreviewMetric, string> = {
  heartRate: "zepp",
  power: "wahoo",
  speed: "wahoo",
  cadence: "wahoo",
  altitude: "garmin",
};

export function activityPreviewSource(metric: PreviewMetric, sourceId: string): PreviewSource {
  const source = metric.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Unknown ${metric.label} preview source: ${sourceId}`);
  return source;
}

/** Builds a mock API response; live metric selection belongs on the server. */
export function activityPreviewPoints(selection: Record<ActivityPreviewMetric, string>) {
  const selected = activityMetricSourcePreview.map((metric) => ({
    key: metric.key,
    source: activityPreviewSource(metric, selection[metric.key]),
  }));
  return timestamps.map((recordedAt, index) => {
    const point: {
      recordedAt: string;
      heartRate: number | null;
      power: number | null;
      speed: number | null;
      cadence: number | null;
      altitude: number | null;
      lat: null;
      lng: null;
    } = {
      recordedAt,
      heartRate: null,
      power: null,
      speed: null,
      cadence: null,
      altitude: null,
      lat: null,
      lng: null,
    };
    for (const { key, source } of selected) point[key] = source.values[index] ?? null;
    return point;
  });
}
