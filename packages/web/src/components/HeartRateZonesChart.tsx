import {
  formatDateMedium,
  formatDurationSeconds,
  formatIntensity,
  formatNumber,
} from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import type { ActivityHrZone, ActivityPowerZone, ZoneDistributionDatum } from "@dofek/zones/zones";
import {
  createZoneDistributionRows,
  formatHeartRateZoneRangeLabel,
  formatPowerZoneRangeLabel,
  HEART_RATE_ZONE_COLORS,
  HEART_RATE_ZONES,
  hasZoneDistributionData,
  POWER_ZONE_COLORS,
} from "@dofek/zones/zones";
import {
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekLegend,
  dofekTooltip,
  escapeTooltipHtml,
} from "../lib/chartTheme.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";
import { DofekChart } from "./DofekChart.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

export interface HeartRateZoneWeek {
  week: string;
  zone0: number;
  zone1: number;
  zone2: number;
  zone3: number;
  zone4: number;
  zone5: number;
}

function formatZoneChartTime(secondsValue: number) {
  return formatDurationSeconds(secondsValue);
}

function formatZoneSeriesLabel(zoneItem: ZoneDistributionDatum): string {
  const [row] = createZoneDistributionRows([zoneItem], [chartThemeColors.axisLabel]);
  if (!row) return zoneItem.label;
  return row.subordinateLabel == null
    ? row.primaryLabel
    : `${row.primaryLabel} ${row.subordinateLabel}`;
}

function getHeartRateZoneSeconds(week: HeartRateZoneWeek, zone: number): number {
  switch (zone) {
    case 0:
      return week.zone0;
    case 1:
      return week.zone1;
    case 2:
      return week.zone2;
    case 3:
      return week.zone3;
    case 4:
      return week.zone4;
    case 5:
      return week.zone5;
    default:
      return 0;
  }
}

function ZoneDistributionChart<ZoneItem extends ZoneDistributionDatum>({
  zones,
  loading,
  height,
  emptyMessage,
  errorMessage,
  zoneColors,
  tooltipDetails,
}: {
  zones: ZoneItem[];
  loading: boolean;
  height: number;
  emptyMessage: string;
  errorMessage?: string;
  zoneColors: string[];
  tooltipDetails: (zone: ZoneItem) => string;
}) {
  if (loading) return <ChartLoadingSkeleton height={height} />;

  if (errorMessage) {
    return (
      <div className="flex items-center justify-center text-center px-4" style={{ height }}>
        <span className="text-red-400 text-sm">{errorMessage}</span>
      </div>
    );
  }

  if (!hasZoneDistributionData(zones)) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-dim text-sm">{emptyMessage}</span>
      </div>
    );
  }

  const rows = createZoneDistributionRows(zones, zoneColors, chartThemeColors.axisLabel);
  const rowByPrimaryLabel = new Map(rows.map((row) => [row.primaryLabel, row]));

  const option = {
    grid: dofekGrid("single", { top: 10, right: 80, bottom: 30, left: 150 }),
    tooltip: dofekTooltip({
      axisPointer: { type: "shadow" },
      formatter: (params: Array<{ value: number; dataIndex: number }>) => {
        const firstParam = params[0];
        if (!firstParam) return "";
        const zoneItem = rows[firstParam.dataIndex]?.zone;
        if (!zoneItem) return "";
        return `<b>${escapeTooltipHtml(zoneItem.label)}</b> (${escapeTooltipHtml(tooltipDetails(zoneItem))})<br/>
          ${formatZoneChartTime(zoneItem.seconds)} (${formatNumber(zoneItem.percent)}%)`;
      },
    }),
    xAxis: dofekAxis.value({
      axisLabel: { formatter: (value: number) => formatZoneChartTime(value) },
    }),
    yAxis: dofekAxis.category({
      data: rows.map((row) => row.primaryLabel),
      show: true,
      axisLabel: {
        show: true,
        interval: 0,
        align: "right",
        margin: 10,
        formatter: (value: string) => {
          const row = rowByPrimaryLabel.get(String(value));
          if (!row || row.subordinateLabel == null) return `{zone|${String(value)}}`;
          return `{zone|${row.primaryLabel}}\n{name|${row.subordinateLabel}}`;
        },
        rich: {
          zone: {
            color: chartThemeColors.axisLabel,
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 13,
          },
          name: {
            color: chartThemeColors.axisLabel,
            fontSize: 10,
            lineHeight: 12,
            opacity: 0.75,
          },
        },
      },
    }),
    series: [
      {
        type: "bar",
        data: rows.map((row) => ({
          value: row.zone.seconds,
          itemStyle: { color: row.color },
        })),
        barWidth: "60%",
        label: {
          show: true,
          position: "right",
          color: chartThemeColors.axisLabel,
          fontSize: 11,
          formatter: (params: { dataIndex: number }) => {
            return rows[params.dataIndex]?.percentLabel ?? "0%";
          },
        },
      },
    ],
  };

  return <DofekChart option={option} height={height} />;
}

export function HrZonesChart({
  zones,
  loading,
  errorMessage,
}: {
  zones: ActivityHrZone[];
  loading: boolean;
  errorMessage?: string;
}) {
  return (
    <ZoneDistributionChart
      zones={zones}
      loading={loading}
      height={200}
      emptyMessage="No heart rate zone data"
      errorMessage={errorMessage}
      zoneColors={HEART_RATE_ZONE_COLORS}
      tooltipDetails={formatHeartRateZoneRangeLabel}
    />
  );
}

export function PowerZonesChart({
  zones,
  ftp,
  loading,
}: {
  zones: ActivityPowerZone[];
  ftp: number;
  loading: boolean;
}) {
  return (
    <ZoneDistributionChart
      zones={zones}
      loading={loading}
      height={240}
      emptyMessage="No power zone data"
      zoneColors={POWER_ZONE_COLORS}
      tooltipDetails={(zoneItem) => formatPowerZoneRangeLabel(zoneItem, ftp)}
    />
  );
}

export function WeeklyHrZonesChart({
  weeks,
  maxHr,
}: {
  weeks: HeartRateZoneWeek[];
  maxHr: number | null;
}) {
  const units = useUnitConverter();
  const maxHeartRateLabel =
    maxHr == null ? null : formatMeasurementText(units.formatHeartRate(maxHr));
  const zoneKeys = HEART_RATE_ZONES.map((zoneDefinition) => `zone${zoneDefinition.zone}`);
  const emptyZonePercentages = Object.fromEntries(zoneKeys.map((zoneKey) => [zoneKey, 0]));
  const zonePercentages = weeks.map((week) => {
    const total = HEART_RATE_ZONES.reduce(
      (sum, zoneDefinition) => sum + getHeartRateZoneSeconds(week, zoneDefinition.zone),
      0,
    );
    if (total === 0) return emptyZonePercentages;
    return Object.fromEntries(
      HEART_RATE_ZONES.map((zoneDefinition) => {
        const zoneKey = `zone${zoneDefinition.zone}`;
        return [zoneKey, (getHeartRateZoneSeconds(week, zoneDefinition.zone) / total) * 100];
      }),
    );
  });

  const series = HEART_RATE_ZONES.map((zoneDefinition) => {
    const seriesName = formatZoneSeriesLabel({
      zone: zoneDefinition.zone,
      label: zoneDefinition.label,
      seconds: 0,
      percent: 0,
    });

    return {
      name: seriesName,
      type: "bar" as const,
      stack: "zones",
      data: weeks.map((week, weekIndex) => [
        week.week,
        Math.round((zonePercentages[weekIndex]?.[`zone${zoneDefinition.zone}`] ?? 0) * 10) / 10,
      ]),
      itemStyle: { color: zoneDefinition.color },
      emphasis: { focus: "series" as const },
    };
  });
  const zoneBySeriesName = new Map(
    HEART_RATE_ZONES.map((zoneDefinition) => [
      formatZoneSeriesLabel({
        zone: zoneDefinition.zone,
        label: zoneDefinition.label,
        seconds: 0,
        percent: 0,
      }),
      zoneDefinition,
    ]),
  );

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
        const week = weeks[firstParam.dataIndex];
        if (!week) return "";
        const dateLabel = formatDateMedium(week.week);
        const lines = params
          .filter((param) => param.value[1] > 0)
          .map((param) => {
            const zoneDefinition = zoneBySeriesName.get(param.seriesName);
            const seconds = zoneDefinition ? getHeartRateZoneSeconds(week, zoneDefinition.zone) : 0;
            return `<span style="color:${escapeTooltipHtml(param.color)}">\u25CF</span> ${escapeTooltipHtml(param.seriesName)}: ${formatIntensity(param.value[1])} (${formatDurationSeconds(seconds)})`;
          });
        return `<strong>${escapeTooltipHtml(dateLabel)}</strong><br/>${lines.join("<br/>")}`;
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
          Heart Rate Zone Distribution{" "}
          {maxHeartRateLabel == null ? null : (
            <span className="text-dim">(max heart rate: {maxHeartRateLabel})</span>
          )}
        </h3>
        <ChartDescriptionTooltip description="This chart shows the percentage of weekly training time spent in each heart rate zone." />
      </div>
      <DofekChart option={option} height={220} />
    </div>
  );
}
