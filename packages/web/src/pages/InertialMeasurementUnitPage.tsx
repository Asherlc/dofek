import { useState } from "react";
import { DofekChart } from "../components/DofekChart.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { PageSection } from "../components/PageSection.tsx";
import { chartColors, chartThemeColors, dofekAxis, dofekTooltip } from "../lib/chartTheme.ts";
import { trpc } from "../lib/trpc.ts";

function formatNumber(n: number): string {
  return n.toLocaleString();
}

/** Map device_id to a user-friendly label */
function deviceLabel(deviceId: string): string {
  switch (deviceId) {
    case "iphone":
      return "iPhone";
    case "apple_watch":
      return "Apple Watch";
    case "whoop":
      return "WHOOP Strap";
    default:
      return deviceId;
  }
}

function SyncStatusPanel() {
  const { data, isLoading, isError } = trpc.inertialMeasurementUnit.getSyncStatus.useQuery();

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (isError) return <p className="text-sm text-red-400">Failed to load motion data.</p>;
  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-muted-foreground">
          No motion data yet. Install the iOS app and grant motion permission to start recording.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {data.map((device) => (
        <div key={device.deviceId} className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{deviceLabel(device.deviceId)}</p>
          </div>
          <p className="text-2xl font-bold">{formatNumber(device.sampleCount)} samples</p>
          <p className="text-xs text-muted-foreground">
            {device.earliestSample
              ? `${new Date(device.earliestSample).toLocaleDateString()} — ${new Date(device.latestSample ?? "").toLocaleDateString()}`
              : "No data"}
          </p>
        </div>
      ))}
    </div>
  );
}

function DailyCoveragePanel() {
  const { data, isLoading, isError } = trpc.inertialMeasurementUnit.getDailyHeatmap.useQuery({
    days: 30,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (isError) return <p className="text-sm text-red-400">Failed to load daily coverage data.</p>;
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No daily data available.</p>;
  }

  // Build unique sorted dates (most recent first) and hour labels
  const dates = [...new Set(data.map((cell) => cell.date))].sort().reverse();
  const hours = Array.from({ length: 24 }, (_, index) => `${index.toString().padStart(2, "0")}:00`);

  // Build heatmap data: [hourIndex, dateIndex, sampleCount, coveragePercent]
  const heatmapData: [number, number, number, number][] = [];
  for (const cell of data) {
    const dateIndex = dates.indexOf(cell.date);
    const hourIndex = cell.hour;
    if (dateIndex >= 0) {
      heatmapData.push([hourIndex, dateIndex, cell.sampleCount, cell.coveragePercent]);
    }
  }

  const chartHeight = Math.max(200, dates.length * 20 + 80);

  const option = {
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: { value: [number, number, number, number] }) => {
        const [hourIndex, dateIndex, count, coveragePercent] = params.value;
        const date = dates[dateIndex] ?? "";
        const hour = hours[hourIndex] ?? "";
        return `<b>${date} ${hour}</b><br/>${count.toLocaleString()} samples (${Math.round(coveragePercent)}% coverage)`;
      },
    }),
    grid: { top: 10, right: 16, bottom: 40, left: 80 },
    xAxis: {
      type: "category" as const,
      data: hours,
      splitArea: { show: true },
      axisLabel: {
        color: chartThemeColors.axisLabel,
        fontSize: 10,
        interval: 2,
      },
      axisLine: { show: false },
    },
    yAxis: {
      type: "category" as const,
      data: dates,
      splitArea: { show: true },
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 10 },
      axisLine: { show: false },
    },
    visualMap: {
      min: 0,
      max: 100,
      dimension: 3,
      calculable: false,
      orient: "horizontal" as const,
      left: "center",
      bottom: 0,
      show: false,
      inRange: {
        color: ["#e8ede7", "#99d1b7", "#059669", "#047857"],
      },
    },
    series: [
      {
        type: "heatmap",
        data: heatmapData,
        emphasis: {
          itemStyle: { shadowBlur: 6, shadowColor: "rgba(0, 0, 0, 0.3)" },
        },
      },
    ],
  };

  return (
    <DofekChart
      option={option}
      loading={isLoading}
      empty={data.length === 0}
      emptyMessage="No daily data available"
      height={chartHeight}
    />
  );
}

function formatDateForQuery(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function CoverageTimelinePanel() {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const dateString = formatDateForQuery(selectedDate);

  const { data, isLoading } = trpc.inertialMeasurementUnit.getCoverageTimeline.useQuery({
    date: dateString,
  });

  const goToPreviousDay = () =>
    setSelectedDate((previous) => new Date(previous.getTime() - 86400000));
  const goToNextDay = () => setSelectedDate((previous) => new Date(previous.getTime() + 86400000));

  const chartData = (data ?? []).map((row) => [row.bucket, row.sampleCount]);

  // At 50 Hz, a full 5-minute bucket has 50 * 300 = 15000 samples
  const maxExpected = 15000;

  const option = {
    tooltip: dofekTooltip({
      formatter: (params: { data: [string, number] }[]) => {
        const point = params[0];
        if (!point) return "";
        const time = new Date(point.data[0]).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const count = point.data[1];
        const pct = ((count / maxExpected) * 100).toFixed(0);
        return `<b>${time}</b><br/>${count.toLocaleString()} samples (${pct}% coverage)`;
      },
    }),
    grid: { top: 10, right: 16, bottom: 30, left: 50 },
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Samples", min: 0 }),
    series: [
      {
        type: "bar",
        data: chartData,
        itemStyle: {
          color: (params: { data: [string, number] }) => {
            const ratio = params.data[1] / maxExpected;
            if (ratio > 0.9) return chartColors.green;
            if (ratio > 0.5) return chartColors.amber;
            return chartColors.orange;
          },
        },
        barMaxWidth: 6,
      },
    ],
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goToPreviousDay}
          className="rounded-lg p-2 text-muted hover:text-foreground hover:bg-accent/10 transition-colors"
          aria-label="Previous day"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5"
          >
            <title>Previous day</title>
            <path
              fillRule="evenodd"
              d="M11.78 5.22a.75.75 0 010 1.06L8.06 10l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <span className="text-sm font-medium">
          {selectedDate.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </span>
        <button
          type="button"
          onClick={goToNextDay}
          className="rounded-lg p-2 text-muted hover:text-foreground hover:bg-accent/10 transition-colors"
          aria-label="Next day"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5"
          >
            <title>Next day</title>
            <path
              fillRule="evenodd"
              d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
      <DofekChart
        option={option}
        loading={isLoading}
        empty={!data || data.length === 0}
        emptyMessage="No motion data for this day"
        height={200}
      />
    </div>
  );
}

export function InertialMeasurementUnitPage() {
  return (
    <PageLayout>
      <PageSection
        title="Motion Tracking"
        subtitle="Continuous 50 Hz motion data (accelerometer + gyroscope) from iPhone, Apple Watch, and WHOOP"
      >
        <SyncStatusPanel />
      </PageSection>
      <PageSection
        title="Connection Timeline"
        subtitle="5-minute coverage — gaps indicate lost BLE connection"
      >
        <CoverageTimelinePanel />
      </PageSection>
      <PageSection title="Daily Coverage" subtitle="When during each day the sensor was recording">
        <DailyCoveragePanel />
      </PageSection>
    </PageLayout>
  );
}
