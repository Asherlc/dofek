import { statusColors } from "@dofek/scoring/colors";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
  OTHER_ACTIVITY_TYPE,
} from "@dofek/training/training";
import { HEART_RATE_ZONES } from "@dofek/zones/zones";
import { z } from "zod";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { formatNumber } from "../lib/format.ts";
import { trpc } from "../lib/trpc.ts";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";
import { DofekChart } from "./DofekChart.tsx";

const ZONE_COLORS: Record<string, string> = Object.fromEntries(
  HEART_RATE_ZONES.map((z) => [`zone${z.zone}`, z.color]),
);

const ZONE_LABELS: Record<string, string> = Object.fromEntries(
  HEART_RATE_ZONES.map((z) => [`zone${z.zone}`, `Z${z.zone} ${z.label}`]),
);

// Activity type colors
const ACTIVITY_COLORS: Record<string, string> = {
  cycling: chartColors.orange,
  running: statusColors.positive,
  walking: chartColors.purple,
  swimming: chartColors.blue,
  hiking: "#a3e635",
  yoga: "#c084fc",
  functional_strength: statusColors.danger,
  strength_training: statusColors.danger,
  strength: statusColors.danger,
  [OTHER_ACTIVITY_TYPE]: chartThemeColors.axisLabel,
};

function getActivityColor(type: string): string {
  return ACTIVITY_COLORS[type.toLowerCase()] ?? chartThemeColors.axisLabel;
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
        <span className="text-dim text-sm">Loading training data...</span>
      </div>
    );
  }

  if (!hasVolume && !hasZones) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No training data in this period</span>
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
    grid: dofekGrid("single", { top: 30, bottom: 40 }),
    tooltip: dofekTooltip({
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
            return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${formatNumber(p.value[1])}h`;
          });
        return `<strong>${dateLabel}</strong> (${formatNumber(total)}h total)<br/>${lines.join("<br/>")}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "Hours" }),
    legend: dofekLegend(true, { type: "scroll" }),
    series,
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-subtle">Weekly Training Volume</h3>
        <ChartDescriptionTooltip description="This chart shows how many training hours you completed each week, broken down by activity type." />
      </div>
      <DofekChart option={option} height={220} />
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
    grid: dofekGrid("single", { top: 30, bottom: 40 }),
    tooltip: dofekTooltip({
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
            return `<span style="color:${p.color}">\u25CF</span> ${p.seriesName}: ${formatNumber(p.value[1])}% (${mins}m)`;
          });
        return `<strong>${dateLabel}</strong><br/>${lines.join("<br/>")}`;
      },
    }),
    xAxis: dofekAxis.time(),
    yAxis: dofekAxis.value({ name: "%", max: 100 }),
    legend: dofekLegend(true),
    series,
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-subtle">
          HR Zone Distribution <span className="text-dim">(max HR: {maxHr} bpm)</span>
        </h3>
        <ChartDescriptionTooltip description="This chart shows the percentage of weekly training time spent in each heart rate zone." />
      </div>
      <DofekChart option={option} height={220} />
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
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: ({ name, value, percent }: { name: string; value: number; percent: number }) => {
        const hours = Math.round(value / 3600);
        return `${name}: ${percent}% (${hours}h)`;
      },
    }),
    legend: {
      orient: "vertical",
      right: 20,
      top: "center",
      textStyle: { color: chartThemeColors.legendText, fontSize: 12 },
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
            bold: {
              fontSize: 28,
              fontWeight: "bold",
              color: chartThemeColors.tooltipText,
              lineHeight: 36,
            },
            sub: { fontSize: 11, color: chartThemeColors.axisLabel, lineHeight: 16 },
          },
        },
        data: [
          { name: `Low (Z1-Z2)`, value: totals.low, itemStyle: { color: statusColors.positive } },
          { name: `Medium (Z3)`, value: totals.medium, itemStyle: { color: statusColors.warning } },
          { name: `High (Z4-Z5)`, value: totals.high, itemStyle: { color: statusColors.danger } },
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
        <h3 className="text-xs font-medium text-subtle">
          Intensity Distribution{" "}
          <span className={`${statusColor} ml-2`}>
            {status} ({lowPct}/{medPct}/{highPct})
          </span>
        </h3>
        <ChartDescriptionTooltip description="This chart summarizes your full time split between low, medium, and high intensity training." />
      </div>
      <DofekChart option={option} height={200} />
      <p className="text-xs text-dim mt-1">
        Target: ~80% low (Z1-Z2), minimal medium (Z3), ~20% high (Z4-Z5)
      </p>
    </div>
  );
}
