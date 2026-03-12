import ReactECharts from "echarts-for-react";
import { trpc } from "../lib/trpc.ts";

// HR zone colors (blue→green→yellow→orange→red)
const ZONE_COLORS = {
  zone1: "#3b82f6", // Recovery (blue)
  zone2: "#22c55e", // Aerobic (green)
  zone3: "#eab308", // Tempo (yellow)
  zone4: "#f97316", // Threshold (orange)
  zone5: "#ef4444", // VO2max (red)
};

const ZONE_LABELS = {
  zone1: "Z1 Recovery",
  zone2: "Z2 Aerobic",
  zone3: "Z3 Tempo",
  zone4: "Z4 Threshold",
  zone5: "Z5 VO2max",
};

// Activity type colors
const ACTIVITY_COLORS: Record<string, string> = {
  cycling: "#f97316",
  running: "#22c55e",
  walking: "#8b5cf6",
  swimming: "#3b82f6",
  hiking: "#a3e635",
  yoga: "#c084fc",
  strength_training: "#ef4444",
};

function getActivityColor(type: string): string {
  return ACTIVITY_COLORS[type.toLowerCase()] ?? "#71717a";
}

interface WeeklyVolumeRow {
  week: string;
  activity_type: string;
  count: number;
  hours: number;
}

interface HrZoneWeek {
  week: string;
  zone1: number;
  zone2: number;
  zone3: number;
  zone4: number;
  zone5: number;
}

interface TrainingInsightsPanelProps {
  days: number;
}

export function TrainingInsightsPanel({ days }: TrainingInsightsPanelProps) {
  const volume = trpc.training.weeklyVolume.useQuery({ days });
  const hrZones = trpc.training.hrZones.useQuery({ days });

  const volumeRows = (volume.data ?? []) as unknown as WeeklyVolumeRow[];
  const zoneData = hrZones.data as unknown as
    | { maxHr: number | null; weeks: HrZoneWeek[] }
    | undefined;
  const zoneWeeks = zoneData?.weeks ?? [];

  const loading = volume.isLoading || hrZones.isLoading;
  const hasVolume = volumeRows.length > 0;
  const hasZones = zoneWeeks.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-zinc-600 text-sm">Loading training data...</span>
      </div>
    );
  }

  if (!hasVolume && !hasZones) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-zinc-600 text-sm">No training data in this period</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {hasVolume && <WeeklyVolumeChart data={volumeRows} />}
      {hasZones && (
        <>
          <HrZoneChart weeks={zoneWeeks} maxHr={zoneData?.maxHr ?? 0} />
          <IntensityDonut weeks={zoneWeeks} />
        </>
      )}
    </div>
  );
}

/** Stacked bar chart: weekly training hours by activity type */
function WeeklyVolumeChart({ data }: { data: WeeklyVolumeRow[] }) {
  // Pivot: collect all weeks and activity types
  const weekSet = [...new Set(data.map((r) => r.week))].sort();
  const typeSet = [...new Set(data.map((r) => r.activity_type))];

  const weekLabels = weekSet.map((w) =>
    new Date(w).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  // Build lookup: week → type → hours
  const lookup = new Map<string, Map<string, number>>();
  for (const row of data) {
    if (!lookup.has(row.week)) lookup.set(row.week, new Map());
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by has() + set() above
    lookup.get(row.week)!.set(row.activity_type, Number(row.hours) || 0);
  }

  const series = typeSet.map((type) => ({
    name: type,
    type: "bar" as const,
    stack: "volume",
    data: weekSet.map((w) => lookup.get(w)?.get(type) ?? 0),
    itemStyle: { color: getActivityColor(type) },
    emphasis: { focus: "series" as const },
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Array<{ seriesName: string; value: number; color: string }>) => {
        const weekLabel = (params[0] as Record<string, unknown>)?.axisValue ?? "";
        let total = 0;
        const lines = params
          .filter((p) => p.value > 0)
          .map((p) => {
            total += p.value;
            return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${p.value.toFixed(1)}h`;
          });
        return `<strong>${weekLabel}</strong> (${total.toFixed(1)}h total)<br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "category",
      data: weekLabels,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "hours",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series,
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">Weekly Training Volume</h3>
      <ReactECharts option={option} style={{ height: 220 }} notMerge={true} />
    </div>
  );
}

/** Stacked bar chart: HR zone distribution per week (percentage view) */
function HrZoneChart({ weeks, maxHr }: { weeks: HrZoneWeek[]; maxHr: number }) {
  const weekLabels = weeks.map((w) =>
    new Date(w.week).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );

  // Convert seconds to percentages per week
  const zonePcts = weeks.map((w) => {
    const total = w.zone1 + w.zone2 + w.zone3 + w.zone4 + w.zone5;
    if (total === 0) return { zone1: 0, zone2: 0, zone3: 0, zone4: 0, zone5: 0 };
    return {
      zone1: (w.zone1 / total) * 100,
      zone2: (w.zone2 / total) * 100,
      zone3: (w.zone3 / total) * 100,
      zone4: (w.zone4 / total) * 100,
      zone5: (w.zone5 / total) * 100,
    };
  });

  const zoneKeys = ["zone1", "zone2", "zone3", "zone4", "zone5"] as const;

  const series = zoneKeys.map((zone) => ({
    name: ZONE_LABELS[zone],
    type: "bar" as const,
    stack: "zones",
    data: zonePcts.map((w) => Math.round(w[zone] * 10) / 10),
    itemStyle: { color: ZONE_COLORS[zone] },
    emphasis: { focus: "series" as const },
  }));

  const option = {
    backgroundColor: "transparent",
    grid: { top: 30, right: 20, bottom: 40, left: 50 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (params: Array<{ seriesName: string; value: number; color: string }>) => {
        const weekLabel = (params[0] as Record<string, unknown>)?.axisValue ?? "";
        // Find original data to show minutes
        const idx = weekLabels.indexOf(weekLabel as string);
        const raw = idx >= 0 ? weeks[idx] : null;
        const lines = params
          .filter((p) => p.value > 0)
          .map((p) => {
            const zoneKey = zoneKeys[params.indexOf(p)];
            const secs = raw && zoneKey ? (raw[zoneKey] ?? 0) : 0;
            const mins = Math.round(secs / 60);
            return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${p.value.toFixed(1)}% (${mins}m)`;
          });
        return `<strong>${weekLabel}</strong><br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "category",
      data: weekLabels,
      axisLabel: { color: "#71717a", fontSize: 11, rotate: 45 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "%",
      max: 100,
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series,
  };

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        HR Zone Distribution <span className="text-zinc-700">(max HR: {maxHr} bpm)</span>
      </h3>
      <ReactECharts option={option} style={{ height: 220 }} notMerge={true} />
    </div>
  );
}

/** Donut chart: overall intensity split (low / medium / high) for 80/20 check */
function IntensityDonut({ weeks }: { weeks: HrZoneWeek[] }) {
  // Aggregate across all weeks
  const totals = weeks.reduce(
    (acc, w) => ({
      low: acc.low + w.zone1 + w.zone2,
      medium: acc.medium + w.zone3,
      high: acc.high + w.zone4 + w.zone5,
    }),
    { low: 0, medium: 0, high: 0 },
  );
  const grand = totals.low + totals.medium + totals.high;
  if (grand === 0) return null;

  const lowPct = Math.round((totals.low / grand) * 100);
  const medPct = Math.round((totals.medium / grand) * 100);
  const highPct = 100 - lowPct - medPct;

  const option = {
    backgroundColor: "transparent",
    tooltip: {
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: ({ name, value, percent }: { name: string; value: number; percent: number }) => {
        const hours = Math.round(value / 3600);
        return `${name}: ${percent}% (${hours}h)`;
      },
    },
    legend: {
      orient: "vertical",
      right: 20,
      top: "center",
      textStyle: { color: "#a1a1aa", fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["50%", "75%"],
        center: ["35%", "50%"],
        avoidLabelOverlap: false,
        label: {
          show: true,
          position: "center",
          formatter: `{bold|${lowPct}%}\n{sub|low intensity}`,
          rich: {
            bold: { fontSize: 28, fontWeight: "bold", color: "#e4e4e7", lineHeight: 36 },
            sub: { fontSize: 11, color: "#71717a", lineHeight: 16 },
          },
        },
        data: [
          { name: `Low (Z1-Z2)`, value: totals.low, itemStyle: { color: "#22c55e" } },
          { name: `Medium (Z3)`, value: totals.medium, itemStyle: { color: "#eab308" } },
          { name: `High (Z4-Z5)`, value: totals.high, itemStyle: { color: "#ef4444" } },
        ],
      },
    ],
  };

  // Determine if polarized (80/20 guideline)
  const isPolarized = lowPct >= 75 && medPct <= 10;
  const status = isPolarized ? "Polarized" : lowPct >= 70 ? "Mostly polarized" : "Not polarized";
  const statusColor = isPolarized
    ? "text-green-500"
    : lowPct >= 70
      ? "text-yellow-500"
      : "text-red-400";

  return (
    <div>
      <h3 className="text-xs font-medium text-zinc-500 mb-2">
        Intensity Distribution{" "}
        <span className={`${statusColor} ml-2`}>
          {status} ({lowPct}/{medPct}/{highPct})
        </span>
      </h3>
      <ReactECharts option={option} style={{ height: 200 }} notMerge={true} />
      <p className="text-xs text-zinc-700 mt-1">
        Target: ~80% low (Z1-Z2), minimal medium (Z3), ~20% high (Z4-Z5)
      </p>
    </div>
  );
}
