import { formatBaselineContext, formatComparisonContext } from "@dofek/format/baseline-context";
import {
  type FormattedMeasurement,
  type FormattedMeasurementFormatter,
  type FormattedMeasurementPart,
  formatNumber,
} from "@dofek/format/format";
import { formatHealthStatusLabel } from "@dofek/format/health-status";
import { formatHealthProvenanceSource } from "@dofek/providers/health-provenance";
import type { HealthMetricKey, HealthStatusMetric } from "dofek-server/mobile-dashboard-contracts";
import type { BaselineRelativeMetric } from "dofek-server/types";
import { useId, useState } from "react";
import { useCountUp } from "../hooks/useCountUp.ts";

interface HealthStatusBarProps {
  baselineRelative?: BaselineRelativeMetric[];
  metrics: HealthStatusMetric[];
  loading?: boolean;
  formatters?: Partial<Record<HealthMetricKey, FormattedMeasurementFormatter>>;
  comparisonFormatters?: Partial<Record<HealthMetricKey, FormattedMeasurementFormatter>>;
  units?: Partial<Record<HealthMetricKey, string>>;
}

const statusColors: Record<HealthStatusMetric["statusColor"], string> = {
  positive: "border-emerald-500 text-emerald-500",
  warning: "border-amber-500 text-amber-500",
  danger: "border-red-500 text-red-500",
  muted: "border-dim text-dim",
};

const statusSymbols: Record<HealthStatusMetric["statusToken"], string> = {
  insufficient_data: "?",
  near_baseline: "✓",
  moving_as_intended: "✓",
  notable_deviation: "!",
  far_from_baseline: "×",
};

function MetricValue({ value }: { value: number | null }) {
  const decimals = value != null && !Number.isInteger(value) ? 1 : 0;
  const display = useCountUp(value, 600, decimals);

  if (value == null) {
    return <span className="text-dim">—</span>;
  }

  return <>{display}</>;
}

function partNeedsUnitStyling(part: FormattedMeasurementPart): boolean {
  return part.type === "unit" || part.type === "percentSign" || part.type === "currency";
}

function renderMeasurementParts(display: FormattedMeasurement) {
  const segments: Array<{ startOffset: number; styledAsUnit: boolean; text: string }> = [];
  let currentOffset = 0;

  for (const part of display.parts) {
    const styledAsUnit = partNeedsUnitStyling(part);
    const lastSegment = segments.at(-1);

    if (lastSegment && lastSegment.styledAsUnit === styledAsUnit) {
      lastSegment.text += part.value;
    } else {
      segments.push({ startOffset: currentOffset, styledAsUnit, text: part.value });
    }
    currentOffset += part.value.length;
  }

  return segments.map((segment) => (
    <span
      key={`${segment.styledAsUnit ? "unit" : "value"}:${segment.startOffset}`}
      className={segment.styledAsUnit ? "text-xs font-normal text-subtle" : undefined}
    >
      {segment.text}
    </span>
  ));
}

function MetricDisplay({
  metric,
  formatter,
  unit,
}: {
  metric: HealthStatusMetric;
  formatter?: FormattedMeasurementFormatter;
  unit?: string;
}) {
  if (metric.valueText != null) {
    return <>{metric.valueText}</>;
  }

  if (formatter) {
    return <>{renderMeasurementParts(formatter(metric.value))}</>;
  }

  return (
    <>
      <MetricValue value={metric.value} />
      {metric.value != null && unit && (
        <span className="ml-1 text-xs font-normal text-subtle">{unit}</span>
      )}
    </>
  );
}

function formatBaseline(
  metric: HealthStatusMetric,
  formatter?: FormattedMeasurementFormatter,
): string {
  if (metric.baseline == null) return "";
  if (metric.baselineText != null) return metric.baselineText;
  return formatter ? formatter(metric.baseline).text : formatNumber(metric.baseline);
}

function formatContextValue(
  value: number,
  formatter: FormattedMeasurementFormatter | undefined,
  unit: string | undefined,
): string {
  if (formatter) return formatter(value).text;
  return `${formatNumber(value)}${unit ? ` ${unit}` : ""}`;
}

function HealthMetricDetails({
  metric,
  baselineDetails,
  comparisonDetails,
}: {
  metric: HealthStatusMetric;
  baselineDetails: string;
  comparisonDetails: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const provenance = metric.provenance;
  const blocked = metric.baselineProgress.blocker !== null;
  return (
    <div className="mt-1 text-[11px] text-subtle">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className="min-h-11 min-w-11 shrink-0 text-left font-medium hover:text-muted"
          aria-expanded={expanded}
          aria-controls={detailsId}
          aria-label={`${expanded ? "Hide" : "Show"} details for ${metric.label}`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>
      <div id={detailsId} hidden={!expanded} className="mt-1 space-y-1 border-l border-border pl-2">
        {expanded ? (
          <>
            {!blocked ? (
              <div className="font-medium text-muted">{metric.evaluationRule}</div>
            ) : null}
            <div>{metric.explanation}</div>
            {blocked ? (
              <>
                <div>{metric.baselineProgress.requirement}</div>
                <div>{metric.baselineProgress.summary}</div>
              </>
            ) : null}
            {baselineDetails ? <div>{baselineDetails}</div> : null}
            {comparisonDetails ? <div>{comparisonDetails}</div> : null}
            {provenance ? (
              <>
                <div>Source: {formatHealthProvenanceSource(provenance)}</div>
                <div>Latest recorded date: {provenance.latestDate ?? "Unavailable"}</div>
                <div>
                  Coverage: {provenance.observedDays}/{provenance.windowDays} days
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function HealthStatusBar({
  baselineRelative = [],
  metrics,
  loading,
  formatters = {},
  comparisonFormatters = {},
  units = {},
}: HealthStatusBarProps) {
  if (loading) {
    return (
      <div className="flex gap-3">
        {["skeleton-1", "skeleton-2", "skeleton-3", "skeleton-4", "skeleton-5"].map((id) => (
          <div key={id} className="flex-1 h-16 rounded-lg shimmer" />
        ))}
      </div>
    );
  }

  if (metrics.length === 0) {
    return (
      <output className="card block p-4 text-sm text-muted">
        No health status data for this period.
      </output>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto">
      {metrics.map((metric, index) => {
        const formatter = formatters[metric.metric];
        const comparisonFormatter = comparisonFormatters[metric.metric] ?? formatter;
        const baselineContext = baselineRelative.find(
          (candidate) => candidate.metric === metric.metric,
        );
        const blocked = metric.baselineProgress.blocker !== null;
        const interpretation = formatHealthStatusLabel(metric);
        return (
          <div
            key={metric.metric}
            className="flex-1 min-w-[120px] card card-hover p-3 stagger-fade-in"
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold leading-none ${statusColors[metric.statusColor]}`}
                role="img"
                aria-label={`${metric.statusLabel} status`}
              >
                {statusSymbols[metric.statusToken]}
              </span>
              <span className="min-w-0 text-[11px] leading-tight text-muted uppercase tracking-wide">
                {metric.label}
              </span>
            </div>
            <div className="whitespace-nowrap text-lg font-semibold font-mono tabular-nums">
              <MetricDisplay metric={metric} formatter={formatter} unit={units[metric.metric]} />
            </div>
            <div className="text-[10px] text-subtle">
              {metric.baseline != null
                ? `baseline ${formatBaseline(metric, formatter)} · ${interpretation}`
                : interpretation}
            </div>
            {blocked ? (
              <section
                aria-label={`${metric.label} baseline progress`}
                className="mt-2 space-y-1 border-t border-border pt-2 text-[10px]"
              >
                <div className="font-medium text-muted">{metric.evaluationRule}</div>
                <div className="text-subtle">
                  {metric.baselineProgress.observedObservationDays} of{" "}
                  {metric.baselineProgress.requiredObservationDays} required days recorded
                </div>
                <div className="font-medium text-foreground">{metric.baselineProgress.action}</div>
              </section>
            ) : null}
            <HealthMetricDetails
              metric={metric}
              baselineDetails={
                baselineContext
                  ? formatBaselineContext(baselineContext, {
                      formatter,
                      unit: units[metric.metric],
                    })
                  : ""
              }
              comparisonDetails={
                !baselineContext && metric.comparison
                  ? formatComparisonContext(metric.comparison, {
                      formatValue: (value) =>
                        formatContextValue(value, comparisonFormatter, units[metric.metric]),
                      missingMeans: "summary",
                    })
                  : ""
              }
            />
          </div>
        );
      })}
    </div>
  );
}
