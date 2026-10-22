import { UnitConverter } from "@dofek/format/units";
import { activityMetricColors } from "@dofek/scoring/colors";
import { activityChartTimingPoints } from "@dofek/training/fixtures/activity-chart-timing";
import {
  type ActivityPreviewMetric,
  activityMetricSourcePreview,
  activityPreviewPoints,
  activityPreviewSource,
  defaultActivityMetricSources,
} from "@dofek/training/fixtures/activity-metric-sources";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ElevationChart, MetricsChart } from "./ActivityDetailCharts.tsx";

const meta = {
  title: "Pages/ActivityDetail/Charts",
  component: MetricsChart,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="p-6">
        <Story />
      </div>
    ),
  ],
  args: {
    points: [
      {
        recordedAt: "2026-10-04T16:52:51.440Z",
        heartRate: 152,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
      {
        recordedAt: "2026-10-04T16:53:51.440Z",
        heartRate: 140,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
      {
        recordedAt: "2026-10-04T16:54:51.440Z",
        heartRate: 145,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
    ],
    activityType: "running",
    hasHr: true,
    hasPower: false,
    hasSpeed: false,
    hasCadence: false,
    loading: false,
    units: new UnitConverter("metric"),
  },
} satisfies Meta<typeof MetricsChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LocalizedTooltip: Story = {};
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = { args: { points: [] } };
export const FractionalReadings: Story = {
  args: {
    points: meta.args.points.map((point, index) => ({
      ...point,
      heartRate: [43.383949279785156, 76.92308044433594, 69.5][index] ?? null,
    })),
  },
};
export const SparseReadings: Story = {
  args: {
    points: [null, 130, null, 145, null, 155, null].map((heartRate, index) => ({
      recordedAt: new Date(Date.UTC(2026, 9, 20, 16, index)).toISOString(),
      heartRate,
      power: null,
      speed: null,
      cadence: null,
      altitude: null,
      lat: null,
      lng: null,
    })),
  },
};

export const IndependentMetricTimelines: Story = {
  args: {
    points: activityChartTimingPoints,
    activityType: "cycling",
    hasPower: true,
  },
};

function MetricControl({
  metric,
  sourceId,
  visible,
  onToggle,
  onChange,
}: {
  metric: (typeof activityMetricSourcePreview)[number];
  sourceId: string;
  visible: boolean;
  onToggle: () => void;
  onChange: (sourceId: string) => void;
}) {
  const source = activityPreviewSource(metric, sourceId);
  const color = metric.key === "altitude" ? "#6b7280" : activityMetricColors[metric.key];

  return (
    <div className="inline-flex min-w-0 items-center rounded-md border border-border">
      <button
        type="button"
        aria-label={`Toggle ${metric.label}`}
        aria-pressed={visible}
        onClick={onToggle}
        className={`flex min-h-9 shrink-0 items-center gap-1.5 rounded-l-md px-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 ${visible ? "text-foreground" : "text-dim line-through"}`}
      >
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: color, opacity: visible ? 1 : 0.35 }}
          aria-hidden="true"
        />
        {metric.key === "heartRate" ? "HR" : metric.label}
      </button>
      <select
        aria-label={`${metric.label} source`}
        title={`${source.sourceLabel} · ${source.attribution}`}
        value={sourceId}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-9 min-w-0 max-w-44 rounded-r-md border-l border-border bg-transparent py-1 pl-2 pr-1 text-xs text-muted focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {metric.sources.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function MetricSourcePreview() {
  const [selection, setSelection] = useState(defaultActivityMetricSources);
  const [elevationVisible, setElevationVisible] = useState(true);
  const points = activityPreviewPoints(selection);
  const units = new UnitConverter("metric");

  function selectSource(metric: ActivityPreviewMetric, sourceId: string) {
    setSelection((previous) => ({ ...previous, [metric]: sourceId }));
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-dim">Sample activity · Strava</p>
          <h2 className="mt-1 text-xl font-semibold text-foreground">Activity metrics</h2>
          <p className="mt-1 text-sm text-muted">October 18 · Two-hour ride</p>
        </div>
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted">
          Preview · Demo recordings
        </span>
      </div>

      <section className="card p-3 sm:p-4" aria-label="Activity metrics">
        <MetricsChart
          points={points}
          activityType="cycling"
          hasHr
          hasPower
          hasSpeed
          hasCadence
          loading={false}
          units={units}
          metricSources={activityMetricSourcePreview
            .filter((metric) => metric.key !== "altitude")
            .map((metric) => ({
              key: metric.key,
              label: metric.key === "heartRate" ? "Heart Rate" : metric.label,
              sources: metric.sources,
              selectedId: selection[metric.key],
              onChange: (sourceId: string) => selectSource(metric.key, sourceId),
            }))}
        />
      </section>

      <section className="card p-3 sm:p-4" aria-label="Elevation profile">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {activityMetricSourcePreview
            .filter((metric) => metric.key === "altitude")
            .map((metric) => (
              <MetricControl
                key={metric.key}
                metric={metric}
                sourceId={selection[metric.key]}
                visible={elevationVisible}
                onToggle={() => setElevationVisible((previous) => !previous)}
                onChange={(sourceId) => selectSource(metric.key, sourceId)}
              />
            ))}
        </div>
        {elevationVisible && <ElevationChart points={points} loading={false} units={units} />}
      </section>
    </div>
  );
}

export const MetricSources: Story = {
  name: "Metric source switchers",
  render: () => <MetricSourcePreview />,
};

export const HeartRateSources: Story = {
  render: function HeartRateSourcesStory(args) {
    const [selectedId, setSelectedId] = useState("whoop");
    return (
      <MetricsChart
        {...args}
        metricSources={[
          {
            key: "heartRate",
            label: "Heart Rate",
            sources: [
              { id: "whoop", label: "WHOOP (Cloud)" },
              { id: "garmin", label: "Garmin" },
            ],
            selectedId,
            onChange: setSelectedId,
          },
        ]}
      />
    );
  },
};
