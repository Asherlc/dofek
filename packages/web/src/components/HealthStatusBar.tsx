import { formatBaselineContext } from "@dofek/format/baseline-context";
import {
  type FormattedMeasurement,
  type FormattedMeasurementFormatter,
  type FormattedMeasurementPart,
  formatNumber,
} from "@dofek/format/format";
import { providerLabel } from "@dofek/providers/providers";
import type {
  HealthMetricKey,
  HealthMetricProvenance,
  HealthStatusMetric,
} from "dofek-server/mobile-dashboard-contracts";
import type { BaselineRelativeMetric } from "dofek-server/types";
import { useState } from "react";
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

function formatComparison(
  metric: HealthStatusMetric,
  formatter: FormattedMeasurementFormatter | undefined,
  unit: string | undefined,
): string {
  const comparison = metric.comparison;
  if (!comparison) return "";
  if (comparison.recentMean == null || comparison.baselineMean == null) {
    return `${comparison.recentDays}d vs prior ${comparison.baselineDays}d · Not enough comparison data`;
  }
  const delta =
    comparison.delta == null ? "—" : formatContextValue(comparison.delta, formatter, unit);
  const signedDelta = comparison.delta != null && comparison.delta > 0 ? `+${delta}` : delta;
  return `${comparison.recentDays}d avg ${formatContextValue(comparison.recentMean, formatter, unit)} vs prior ${comparison.baselineDays}d avg ${formatContextValue(comparison.baselineMean, formatter, unit)} · ${signedDelta}`;
}

function provenanceSourceText(provenance: HealthMetricProvenance): string {
  const sourceLabels = provenance.sourceProviders.map(providerLabel);
  return sourceLabels.length > 0 ? sourceLabels.join(", ") : "Unknown source";
}

function provenanceSummaryText(provenance: HealthMetricProvenance): string {
  const latestText = provenance.latestDate
    ? `latest ${provenance.latestDate}`
    : "latest unavailable";
  return `${provenanceSourceText(provenance)} · ${provenance.observedDays}/${provenance.windowDays} days · ${latestText}`;
}

function HealthMetricProvenanceDisclosure({ metric }: { metric: HealthStatusMetric }) {
  const [expanded, setExpanded] = useState(false);
  const provenance = metric.provenance;

  if (!provenance) return null;

  const sourceText = provenanceSourceText(provenance);
  return (
    <div className="mt-1 text-[10px] text-subtle">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left hover:text-muted"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} source details for ${metric.label}`}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>{provenanceSummaryText(provenance)}</span>
        <span className="shrink-0 font-medium">{expanded ? "Hide details" : "Details"}</span>
      </button>
      {expanded ? (
        <div className="mt-1 space-y-0.5 border-l border-border pl-2">
          <div>Source: {sourceText}</div>
          <div>Latest recorded date: {provenance.latestDate ?? "Unavailable"}</div>
          <div>
            Coverage: {provenance.observedDays}/{provenance.windowDays} days
          </div>
        </div>
      ) : null}
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
                ? `baseline ${formatBaseline(metric, formatter)} · ${metric.statusLabel}`
                : metric.statusLabel}
            </div>
            <div className="mt-1 text-[10px] font-medium text-muted">{metric.evaluationRule}</div>
            <div className="mt-1 text-[10px] text-subtle">{metric.explanation}</div>
            {metric.baselineProgress.blocker !== null ? (
              <section
                aria-label={`${metric.label} baseline progress`}
                className="mt-2 space-y-1 border-t border-border pt-2 text-[10px]"
              >
                <div className="font-medium text-muted">{metric.baselineProgress.requirement}</div>
                <div className="text-subtle">
                  {metric.baselineProgress.observedObservationDays} of{" "}
                  {metric.baselineProgress.requiredObservationDays} required days recorded
                </div>
                <div className="text-subtle">{metric.baselineProgress.summary}</div>
                <div className="font-medium text-foreground">{metric.baselineProgress.action}</div>
              </section>
            ) : null}
            {baselineContext ? (
              <div className="mt-1 text-[10px] text-subtle">
                {formatBaselineContext(baselineContext, {
                  formatter,
                  unit: units[metric.metric],
                })}
              </div>
            ) : null}
            <HealthMetricProvenanceDisclosure metric={metric} />
            {!baselineContext && metric.comparison ? (
              <div className="mt-1 text-[10px] text-subtle">
                {formatComparison(metric, comparisonFormatter, units[metric.metric])}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
