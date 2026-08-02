import { formatDateShort } from "@dofek/format/format";
import { formatMeasurementText } from "@dofek/format/units";
import type { BaselineProgress } from "dofek-server/mobile-dashboard-contracts";
import type { ReactNode } from "react";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ChartContainer } from "./ChartContainer.tsx";
import type { Insight } from "./CorrelationCard.tsx";
import { InsightEvidenceDetails } from "./InsightEvidenceDetails.tsx";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export interface DashboardTrendSnapshot {
  latestRestingHeartRate: number | null | undefined;
  averageRestingHeartRate: number | null | undefined;
  restingHeartRateTrendLabel?: string | null;
  restingHeartRateBaselineProgress?: BaselineProgress | null;
  restingHeartRatePoints?: RestingHeartRatePoint[] | null | undefined;
}

export interface RestingHeartRatePoint {
  date: string;
  value: number;
}

export interface TrainingSleepComparisonPoint {
  date: string;
  trainingLoad: number;
  sleepConsistency: number;
}

export function formatDashboardRange(endDate: string, days: number): string {
  const end = new Date(`${endDate}T12:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - days + 1);
  const utc = { timeZone: "UTC" as const };
  return `${formatDateShort(start, utc)} - ${formatDateShort(end, utc)}`;
}

export function trendPositionLabel(trend: DashboardTrendSnapshot): string {
  return trend.restingHeartRateTrendLabel ?? "Waiting for baseline";
}

interface ChartLabels {
  xAxis: string;
  xMetric: string;
  yAxis: string;
  yMetric: string;
}

interface ScatterPoint {
  date: string;
  xValue: number;
  yValue: number;
}

interface RestingHeartRateTone {
  className: string;
  colorVariable: string;
  fillOpacity: string;
}

function formatChartDate(date: string): string {
  return formatDateShort(date, { timeZone: "UTC" });
}

function formatChartNumber(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function restingHeartRateTone(trend: DashboardTrendSnapshot): RestingHeartRateTone {
  const trendLabel = trendPositionLabel(trend);
  if (trendLabel === "Waiting for baseline") {
    return {
      className: "text-muted",
      colorVariable: "var(--color-muted)",
      fillOpacity: "0.08",
    };
  }
  if (trendLabel === "below average" || trendLabel === "at average") {
    return {
      className: "text-accent",
      colorVariable: "var(--color-accent)",
      fillOpacity: "0.1",
    };
  }
  return {
    className: "text-danger",
    colorVariable: "var(--color-danger)",
    fillOpacity: "0.08",
  };
}

export function DashboardEvidenceOverview({
  days,
  endDate,
  topInsight,
  insightError,
  trend,
  restingHeartRateLoading = false,
  restingHeartRateError = null,
  trainingSleepPoints,
  healthMonitor,
}: {
  days: number;
  endDate: string;
  topInsight?: Insight;
  insightError?: ReactNode;
  trend: DashboardTrendSnapshot;
  restingHeartRateLoading?: boolean;
  restingHeartRateError?: unknown;
  trainingSleepPoints?: TrainingSleepComparisonPoint[] | null | undefined;
  healthMonitor: ReactNode;
}) {
  const units = useUnitConverter();
  const effectSize = topInsight?.effectSize;
  const evidence = topInsight?.evidence;
  const relationship =
    evidence?.relationship ??
    (topInsight?.type === "conditional"
      ? "descriptive_association"
      : topInsight?.type === "correlation"
        ? "correlation"
        : undefined);
  const relationshipHeading =
    relationship === "descriptive_association"
      ? "Association"
      : relationship === "correlation"
        ? "Correlation"
        : "Relationship";
  const relationshipValue =
    relationship === "descriptive_association"
      ? evidence?.estimateLabel?.trim() || "--"
      : relationship === "correlation" && effectSize != null
        ? Number(effectSize.toFixed(2)) === 0
          ? "0.00"
          : effectSize.toFixed(2)
        : "--";
  const trendLabel = trendPositionLabel(trend);
  const restingHeartRateToneValue = restingHeartRateTone(trend);
  const formatRestingHeartRate = (value: number) =>
    formatMeasurementText(units.formatHeartRate(value));
  const insightChartPoints =
    topInsight?.dataPoints
      ?.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => ({ date: point.date, xValue: point.x, yValue: point.y })) ?? [];
  const restingHeartRatePoints =
    trend.restingHeartRatePoints?.filter((point) => Number.isFinite(point.value)) ?? [];
  const trainingSleepChartPoints =
    trainingSleepPoints
      ?.filter(
        (point) => Number.isFinite(point.trainingLoad) && Number.isFinite(point.sleepConsistency),
      )
      .map((point) => ({
        date: point.date,
        xValue: point.trainingLoad,
        yValue: point.sleepConsistency,
      })) ?? [];

  return (
    <section
      aria-label="Dashboard overview"
      className="dashboard-hero card p-5 sm:p-6 lg:min-h-[calc(100vh-4rem)]"
    >
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Overview</h2>
          <p className="mt-1 text-sm text-muted">{formatDashboardRange(endDate, days)}</p>
        </div>
        <span className="w-fit rounded-md border border-border bg-surface-solid px-3 py-1.5 text-xs font-medium text-foreground">
          {days} days
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <EvidenceCard eyebrow={`Key ${relationshipHeading.toLowerCase()}`}>
          {insightError ? (
            insightError
          ) : (
            <div>
              <h3 className="text-base font-medium leading-snug text-foreground">
                {topInsight?.message ?? "Sleep consistency + Heart Rate Variability"}
              </h3>
              <div className="mt-5 grid grid-cols-[0.7fr_1fr] items-end gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                    {relationshipHeading}
                  </p>
                  <p className="mt-1 font-mono text-4xl font-bold tabular-nums text-accent">
                    {relationshipValue}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-accent">
                    {evidence?.label?.trim() || "Descriptive relationship"}
                  </p>
                </div>
                <MiniChartFrame data={topInsight ? insightChartPoints : []}>
                  {topInsight ? (
                    <MiniScatter
                      points={insightChartPoints}
                      labels={{
                        xAxis: topInsight.action,
                        xMetric: topInsight.action,
                        yAxis: topInsight.metric,
                        yMetric: topInsight.metric,
                      }}
                    />
                  ) : null}
                </MiniChartFrame>
              </div>
              {evidence && <InsightEvidenceDetails evidence={evidence} className="mt-4" />}
            </div>
          )}
        </EvidenceCard>

        <EvidenceCard eyebrow="Recent trend">
          <h3 className="text-base font-medium text-foreground">Resting heart rate</h3>
          <div className="mt-7 grid grid-cols-[0.65fr_1fr] items-end gap-5">
            <div>
              <p
                className={`font-mono text-4xl font-bold tabular-nums ${restingHeartRateToneValue.className}`}
              >
                {trend.latestRestingHeartRate != null
                  ? Math.round(trend.latestRestingHeartRate)
                  : "--"}
              </p>
              <p className="text-xs text-muted">bpm</p>
              <p className="text-xs text-muted">{trendLabel}</p>
            </div>
            <MiniChartFrame
              data={restingHeartRatePoints.length > 1 ? restingHeartRatePoints : []}
              loading={restingHeartRateLoading}
              error={restingHeartRateError}
              height={112}
            >
              <MiniTrend
                points={restingHeartRatePoints}
                averageRestingHeartRate={trend.averageRestingHeartRate}
                formatRestingHeartRate={formatRestingHeartRate}
                tone={restingHeartRateToneValue}
              />
            </MiniChartFrame>
          </div>
          {trend.restingHeartRateBaselineProgress &&
          trend.restingHeartRateBaselineProgress.blocker !== null ? (
            <section
              aria-label="Resting heart rate baseline progress"
              className="mt-4 space-y-1 border-t border-border pt-3 text-xs"
            >
              <p className="font-medium text-muted">
                {trend.restingHeartRateBaselineProgress.requirement}
              </p>
              <p className="text-subtle">
                {trend.restingHeartRateBaselineProgress.observedObservationDays} of{" "}
                {trend.restingHeartRateBaselineProgress.requiredObservationDays} required days
                recorded
              </p>
              <p className="text-subtle">{trend.restingHeartRateBaselineProgress.summary}</p>
              <p className="font-medium text-foreground">
                {trend.restingHeartRateBaselineProgress.action}
              </p>
            </section>
          ) : null}
        </EvidenceCard>

        <EvidenceCard eyebrow="Training load compared with sleep consistency">
          <h3 className="max-w-sm text-base font-medium leading-relaxed text-foreground">
            Higher load weeks can be reviewed beside sleep and recovery.
          </h3>
          <div className="mt-5">
            <MiniChartFrame data={trainingSleepChartPoints}>
              <MiniScatter
                points={trainingSleepChartPoints}
                labels={{
                  xAxis: "Load",
                  xMetric: "Training load",
                  yAxis: "Sleep",
                  yMetric: "Sleep consistency",
                }}
              />
            </MiniChartFrame>
          </div>
        </EvidenceCard>
      </div>

      <div className="mt-3 rounded-lg border border-border bg-surface p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-muted">
          Health monitor
        </p>
        {healthMonitor}
      </div>
    </section>
  );
}

function EvidenceCard({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <div className="min-h-[15rem] rounded-lg border border-border bg-surface p-5">
      <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
      {children}
    </div>
  );
}

function MiniChartFrame({
  data,
  loading = false,
  error,
  height = 96,
  children,
}: {
  data: unknown[];
  loading?: boolean;
  error?: unknown;
  height?: number;
  children: ReactNode;
}) {
  if (error) return <QueryStatePanel error={error} height={height} />;
  return (
    <ChartContainer loading={loading} data={data} height={height} emptyMessage="No chart data yet.">
      {children}
    </ChartContainer>
  );
}

function chartDomain(values: number[]): { min: number; max: number } {
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  if (minValue === maxValue) return { min: minValue - 1, max: maxValue + 1 };
  const padding = (maxValue - minValue) * 0.08;
  return { min: minValue - padding, max: maxValue + padding };
}

function MiniScatter({ points, labels }: { points: ScatterPoint[]; labels: ChartLabels }) {
  const chart = { left: 28, right: 142, top: 12, bottom: 62 };
  const xDomain = chartDomain(points.map((point) => point.xValue));
  const yDomain = chartDomain(points.map((point) => point.yValue));
  const xRange = xDomain.max - xDomain.min;
  const yRange = yDomain.max - yDomain.min;
  const toX = (value: number) =>
    chart.left + ((value - xDomain.min) / xRange) * (chart.right - chart.left);
  const toY = (value: number) =>
    chart.bottom - ((value - yDomain.min) / yRange) * (chart.bottom - chart.top);
  const color = "var(--color-muted)";

  return (
    <svg viewBox="0 0 156 86" className="h-24 w-full" role="img" aria-hidden="true">
      <path
        d={`M${chart.left} ${chart.bottom}H${chart.right}`}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      <path
        d={`M${chart.left} ${chart.top}V${chart.bottom}`}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      <path
        d={`M${chart.right} ${chart.bottom}V${chart.bottom + 3}`}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      <path
        d={`M${chart.left - 3} ${chart.top}H${chart.left}`}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      <text x={chart.left} y="8" fill="var(--color-muted)" fontSize="8">
        {labels.yAxis}
      </text>
      <text
        x={(chart.left + chart.right) / 2}
        y="80"
        fill="var(--color-muted)"
        fontSize="8"
        textAnchor="middle"
      >
        {labels.xAxis}
      </text>
      {points.map((point) => (
        <circle
          key={`${point.date}-${point.xValue}-${point.yValue}`}
          cx={toX(point.xValue)}
          cy={toY(point.yValue)}
          r="3"
          className="cursor-help"
          fill={color}
        >
          <title>
            {formatChartDate(point.date)}: {labels.xMetric}: {formatChartNumber(point.xValue)},{" "}
            {labels.yMetric}: {formatChartNumber(point.yValue)}
          </title>
        </circle>
      ))}
    </svg>
  );
}

function MiniTrend({
  points,
  averageRestingHeartRate,
  formatRestingHeartRate,
  tone,
}: {
  points: RestingHeartRatePoint[];
  averageRestingHeartRate: number | null | undefined;
  formatRestingHeartRate: (value: number) => string;
  tone: RestingHeartRateTone;
}) {
  const chart = { left: 28, right: 152, top: 10, bottom: 68 };
  const labelValues = [
    ...points.map((point) => point.value),
    ...(averageRestingHeartRate != null ? [averageRestingHeartRate] : []),
  ];
  const labelMin = Math.min(...labelValues);
  const labelMax = Math.max(...labelValues);
  const domain = chartDomain(labelValues);
  const valueRange = domain.max - domain.min;
  const toX = (index: number) =>
    chart.left + (index / Math.max(points.length - 1, 1)) * (chart.right - chart.left);
  const toY = (value: number) =>
    chart.bottom - ((value - domain.min) / valueRange) * (chart.bottom - chart.top);
  const pathData = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${toX(index)} ${toY(point.value)}`)
    .join("");
  const areaData = `${pathData}L${toX(points.length - 1)} ${chart.bottom}L${toX(
    0,
  )} ${chart.bottom}Z`;
  const averageY = averageRestingHeartRate != null ? toY(averageRestingHeartRate) : undefined;
  const firstPoint = points[0];
  const lastPoint = points.at(-1);

  return (
    <svg viewBox="0 0 168 92" className="h-28 w-full" role="img" aria-hidden="true">
      <path
        d={`M${chart.left} ${chart.bottom}H${chart.right}`}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      <path
        d={`M${chart.left} ${chart.top}V${chart.bottom}`}
        stroke="var(--color-border-strong)"
        strokeWidth="1"
      />
      {averageY != null && (
        <path
          d={`M${chart.left} ${averageY}H${chart.right}`}
          stroke="var(--color-border-strong)"
          strokeWidth="0.75"
          opacity="0.5"
        />
      )}
      <path d={pathData} fill="none" stroke={tone.colorVariable} strokeWidth="2" />
      <path d={areaData} fill={tone.colorVariable} opacity={tone.fillOpacity} />
      {points.map((point, index) => (
        <circle
          key={`${point.date}-${point.value}`}
          cx={toX(index)}
          cy={toY(point.value)}
          r="3"
          className="cursor-help"
          fill={tone.colorVariable}
        >
          <title>
            {formatChartDate(point.date)}: Resting heart rate: {formatRestingHeartRate(point.value)}
          </title>
        </circle>
      ))}
      <text
        x={chart.left - 3}
        y={toY(labelMax) + 2}
        fill="var(--color-muted)"
        fontSize="7"
        textAnchor="end"
      >
        {formatRestingHeartRate(labelMax)}
      </text>
      {labelMin !== labelMax && (
        <text
          x={chart.left - 3}
          y={toY(labelMin) + 2}
          fill="var(--color-muted)"
          fontSize="7"
          textAnchor="end"
        >
          {formatRestingHeartRate(labelMin)}
        </text>
      )}
      {firstPoint && (
        <text x={chart.left} y="86" fill="var(--color-muted)" fontSize="8" textAnchor="middle">
          {formatChartDate(firstPoint.date)}
        </text>
      )}
      {lastPoint && (
        <text x={chart.right} y="86" fill="var(--color-muted)" fontSize="8" textAnchor="middle">
          {formatChartDate(lastPoint.date)}
        </text>
      )}
    </svg>
  );
}
