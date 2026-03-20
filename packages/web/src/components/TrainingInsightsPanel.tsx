import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
  OTHER_ACTIVITY_TYPE,
} from "@dofek/training/training";
import ReactECharts from "echarts-for-react";
import { z } from "zod";
import { trpc } from "../lib/trpc.ts";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";

// HR zone colors (blue->green->yellow->orange->red)
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
  functional_strength: "#dc2626",
  strength_training: "#ef4444",
  strength: "#ef4444",
  [OTHER_ACTIVITY_TYPE]: "#71717a",
};

function getActivityColor(type: string): string {
  return ACTIVITY_COLORS[type.toLowerCase()] ?? "#71717a";
}

const weeklyVolumeRowSchema = z.object({
  week: z.string(),
  activity_type: z.string(),
  count: z.number(),
  hours: z.number(),
});
type WeeklyVolumeRow = z.infer<typeof weeklyVolumeRowSchema>;

const hrZoneWeekSchema = z.object({
  week: z.string(),
  zone1: z.number(),
  zone2: z.number(),
  zone3: z.number(),
  zone4: z.number(),
  zone5: z.number(),
});
type HrZoneWeek = z.infer<typeof hrZoneWeekSchema>;

interface TrainingInsightsPanelProps {
  days: number;
}

export function TrainingInsightsPanel({ days }: TrainingInsightsPanelProps) {
  const volume = trpc.training.weeklyVolume.useQuery({ days });
  const hrZones = trpc.training.hrZones.useQuery({ days });

  // tRPC infers raw SQL result types as Record<string, unknown>;
  // narrow to known row shapes via typed identity function
  const volumeRows = z.array(weeklyVolumeRowSchema).parse(volume.data ?? []);
  const zoneData = z
    .object({ maxHr: z.number().nullable(), weeks: z.array(hrZoneWeekSchema) })
    .optional()
    .parse(hrZones.data);
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
  const collapsedRows = collapseWeeklyVolumeActivityTypes(data, 6);

  // Pivot: collect all weeks and activity types
  const weekSet = [...new Set(collapsedRows.map((r) => r.week))].sort();
  const typeTotals = collapsedRows.reduce(
    (acc, row) => acc.set(row.activity_type, (acc.get(row.activity_type) ?? 0) + row.hours),
    new Map<string, number>(),
  );
  const typeSet = [...typeTotals.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);

  // Build lookup: week -> type -> hours
  const lookup = new Map<string, Map<string, number>>();
  for (const row of collapsedRows) {
    let inner = lookup.get(row.week);
    if (!inner) {
      inner = new Map();
      lookup.set(row.week, inner);
    }
    inner.set(row.activity_type, Number(row.hours) || 0);
  }

  const series = typeSet.map((type) => ({
    name: formatActivityTypeLabel(type),
    type: "bar" as const,
    stack: "volume",
    data: weekSet.map((w) => [w, lookup.get(w)?.get(type) ?? 0]),
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
      formatter: (
        params: Array<{ seriesName: string; value: [string, number]; color: string }>,
      ) => {
        if (!params.length) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const dateLabel = new Date(firstParam.value[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        let total = 0;
        const lines = params
          .filter((p) => p.value[1] > 0)
          .map((p) => {
            total += p.value[1];
            return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${p.value[1].toFixed(1)}h`;
          });
        return `<strong>${dateLabel}</strong> (${total.toFixed(1)}h total)<br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
    },
    yAxis: {
      type: "value",
      name: "Hours",
      splitLine: { lineStyle: { color: "#27272a" } },
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { show: false },
      nameTextStyle: { color: "#71717a", fontSize: 11 },
    },
    legend: {
      type: "scroll" as const,
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    series,
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-zinc-500">Weekly Training Volume</h3>
        <ChartDescriptionTooltip description="This chart shows how many training hours you completed each week, broken down by activity type." />
      </div>
      <ReactECharts option={option} style={{ height: 220 }} notMerge={true} />
    </div>
  );
}

/** Stacked bar chart: HR zone distribution per week (percentage view) */
function HrZoneChart({ weeks, maxHr }: { weeks: HrZoneWeek[]; maxHr: number }) {
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
    data: weeks.map((w, i) => [w.week, Math.round((zonePcts[i]?.[zone] ?? 0) * 10) / 10]),
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
      formatter: (
        params: Array<{
          seriesName: string;
          value: [string, number];
          color: string;
          dataIndex: number;
        }>,
      ) => {
        if (!params.length) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const idx = firstParam.dataIndex;
        const raw = weeks[idx];
        if (!raw) return "";
        const dateLabel = new Date(raw.week).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const lines = params
          .filter((p) => p.value[1] > 0)
          .map((p) => {
            const zoneKey = zoneKeys[params.indexOf(p)];
            const secs = raw && zoneKey ? (raw[zoneKey] ?? 0) : 0;
            const mins = Math.round(secs / 60);
            return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${p.value[1].toFixed(1)}% (${mins}m)`;
          });
        return `<strong>${dateLabel}</strong><br/>${lines.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
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
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-zinc-500">
          HR Zone Distribution <span className="text-zinc-700">(max HR: {maxHr} bpm)</span>
        </h3>
        <ChartDescriptionTooltip description="This chart shows the percentage of weekly training time spent in each heart rate zone." />
      </div>
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
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-zinc-500">
          Intensity Distribution{" "}
          <span className={`${statusColor} ml-2`}>
            {status} ({lowPct}/{medPct}/{highPct})
          </span>
        </h3>
        <ChartDescriptionTooltip description="This chart summarizes your full time split between low, medium, and high intensity training." />
      </div>
      <ReactECharts option={option} style={{ height: 200 }} notMerge={true} />
      <p className="text-xs text-zinc-700 mt-1">
        Target: ~80% low (Z1-Z2), minimal medium (Z3), ~20% high (Z4-Z5)
      </p>
    </div>
  );
}
