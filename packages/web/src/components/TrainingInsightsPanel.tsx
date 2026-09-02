import {
  formatDateMedium,
  formatDurationMinutes,
  formatDurationSeconds,
  formatIntensity,
} from "@dofek/format/format";
import { statusColors } from "@dofek/scoring/colors";
import { TRAINING_TERMINOLOGY } from "@dofek/training/terminology";
import {
  collapseWeeklyVolumeActivityTypes,
  formatActivityTypeLabel,
  OTHER_ACTIVITY_TYPE,
} from "@dofek/training/training";
import { HEART_RATE_ZONE_COLORS } from "@dofek/zones/zones";
import { z } from "zod";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { selectedRangeQueryInput, type TimeRangeDays } from "../lib/timeRange.ts";
import { trpc } from "../lib/trpc.ts";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";
import { DofekChart } from "./DofekChart.tsx";
import { WeeklyHrZonesChart } from "./HeartRateZonesChart.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

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
  canonical_type: z.string(),
  count: z.number(),
  hours: z.number(),
});
type WeeklyVolumeRow = z.infer<typeof weeklyVolumeRowSchema>;

const hrZoneWeekSchema = z.object({
  week: z.string(),
  zone0: z.number(),
  zone1: z.number(),
  zone2: z.number(),
  zone3: z.number(),
  zone4: z.number(),
  zone5: z.number(),
});
const intensityDistributionSchema = z.object({
  model: z.literal("karvonen-five-zone"),
  activityScope: z.literal("endurance"),
  totalSeconds: z.number(),
  zones: z.array(
    z.object({
      zone: z.number(),
      label: z.string(),
      seconds: z.number(),
      percent: z.number(),
    }),
  ),
  explanation: z.string(),
});
type IntensityDistribution = z.infer<typeof intensityDistributionSchema>;

interface TrainingInsightsPanelProps {
  days: TimeRangeDays;
}

export function TrainingInsightsPanel({ days }: TrainingInsightsPanelProps) {
  const volume = trpc.training.weeklyVolume.useQuery(selectedRangeQueryInput(days));
  const hrZones = trpc.training.hrZones.useQuery(selectedRangeQueryInput(days));

  // tRPC infers raw SQL result types as Record<string, unknown>;
  // narrow to known row shapes via typed identity function
  const volumeRows = volume.data == null ? [] : z.array(weeklyVolumeRowSchema).parse(volume.data);
  const zoneData = z
    .object({
      maxHr: z.number().nullable(),
      weeks: z.array(hrZoneWeekSchema),
      intensityDistribution: intensityDistributionSchema,
    })
    .optional()
    .parse(hrZones.data);
  const zoneWeeks = zoneData?.weeks ?? [];

  const loading =
    volume.isLoading && volume.data == null && hrZones.isLoading && hrZones.data == null;
  const hasVolume = volumeRows.length > 0;
  const hasZones = zoneWeeks.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[200px]">
        <span className="text-dim text-sm">Loading training data...</span>
      </div>
    );
  }

  if (
    !volume.error &&
    !hrZones.error &&
    !volume.isLoading &&
    !hrZones.isLoading &&
    !hasVolume &&
    !hasZones
  ) {
    return (
      <div className="flex items-center justify-center h-[100px]">
        <span className="text-dim text-sm">No training data in this period</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {volume.error && <QueryStatePanel error={volume.error} />}
      {volume.isLoading && volume.data == null ? (
        <div className="flex items-center justify-center h-[100px]">
          <span className="text-dim text-sm">Loading weekly volume...</span>
        </div>
      ) : (
        hasVolume && <WeeklyVolumeChart data={volumeRows} />
      )}
      {hrZones.error && <QueryStatePanel error={hrZones.error} />}
      {hrZones.isLoading && hrZones.data == null ? (
        <div className="flex items-center justify-center h-[100px]">
          <span className="text-dim text-sm">Loading heart-rate zones...</span>
        </div>
      ) : (
        hasZones && (
          <>
            <WeeklyHrZonesChart weeks={zoneWeeks} maxHr={zoneData?.maxHr ?? null} />
            {zoneData && <IntensityDonut distribution={zoneData.intensityDistribution} />}
          </>
        )
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
    (acc, row) => acc.set(row.canonical_type, (acc.get(row.canonical_type) ?? 0) + row.hours),
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
    inner.set(row.canonical_type, Number(row.hours) || 0);
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
        const dateLabel = formatDateMedium(firstParam.value[0]);
        let total = 0;
        const lines = params
          .filter((p) => p.value[1] > 0)
          .map((p) => {
            total += p.value[1];
            return `<span style="color:${escapeTooltipHtml(p.color)}">\u25CF</span> ${escapeTooltipHtml(p.seriesName)}: ${formatDurationMinutes(p.value[1] * 60)}`;
          });
        return `<strong>${escapeTooltipHtml(dateLabel)}</strong> (${formatDurationMinutes(total * 60)} total)<br/>${lines.join("<br/>")}`;
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

/** Donut chart for the server-computed descriptive Karvonen distribution. */
function IntensityDonut({ distribution }: { distribution: IntensityDistribution }) {
  if (distribution.totalSeconds === 0) return null;
  const option = {
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: ({
        name,
        value,
        data,
      }: {
        name: string;
        value: number;
        data: { serverPercent: number };
      }) => {
        return `${escapeTooltipHtml(name)}: ${formatIntensity(data.serverPercent)} (${formatDurationSeconds(value)})`;
      },
    }),
    legend: dofekLegend(true, { type: "scroll" }),
    series: [
      {
        type: "pie",
        radius: ["50%", "75%"],
        avoidLabelOverlap: true,
        data: distribution.zones.map((zone) => ({
          name: zone.zone === 0 ? zone.label : `Zone ${zone.zone}: ${zone.label}`,
          value: zone.seconds,
          serverPercent: zone.percent,
          itemStyle: { color: HEART_RATE_ZONE_COLORS[zone.zone] ?? chartThemeColors.axisLabel },
        })),
      },
    ],
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-subtle">
          {TRAINING_TERMINOLOGY.intensityDistribution.plainLabel}
        </h3>
        <ChartDescriptionTooltip
          description={`Technical name: ${TRAINING_TERMINOLOGY.intensityDistribution.technicalName}. ${TRAINING_TERMINOLOGY.intensityDistribution.details} ${distribution.explanation}`}
        />
      </div>
      <DofekChart option={option} height={200} />
      <p className="text-xs text-dim mt-1">
        {TRAINING_TERMINOLOGY.intensityDistribution.plainDescription}
      </p>
    </div>
  );
}
