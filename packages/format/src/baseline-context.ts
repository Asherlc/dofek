import { type FormattedMeasurementFormatter, formatNumber } from "./format.ts";

export interface BaselineContextMetric {
  baseline: {
    mean: number | null;
    sampleCount: number;
    standardDeviation: number | null;
    windowDays: number;
    zScore: number | null;
  };
  comparison: {
    baselineDays: number;
    delta: number | null;
    recentDays: number;
  };
}

export interface BaselineContextFormatOptions {
  formatter?: FormattedMeasurementFormatter;
  unit?: string;
}

export function formatComparisonPeriod(
  comparison: Pick<BaselineContextMetric["comparison"], "recentDays" | "baselineDays">,
): string {
  return `${comparison.recentDays}d vs prior ${comparison.baselineDays}d`;
}

type ComparisonContext = BaselineContextMetric["comparison"] & {
  recentMean: number | null;
  baselineMean: number | null;
};

export function formatComparisonContext(
  comparison: ComparisonContext,
  options: {
    formatValue: (value: number) => string;
    missingMeans: "summary" | "values";
  },
): string {
  if (
    options.missingMeans === "summary" &&
    (comparison.recentMean == null || comparison.baselineMean == null)
  ) {
    return `${formatComparisonPeriod(comparison)} · Not enough comparison data`;
  }

  const formatValue = (value: number | null): string =>
    value == null ? "—" : options.formatValue(value);
  const delta = formatValue(comparison.delta);
  const signedDelta = comparison.delta != null && comparison.delta > 0 ? `+${delta}` : delta;
  return `${comparison.recentDays}d avg ${formatValue(comparison.recentMean)} vs prior ${comparison.baselineDays}d avg ${formatValue(comparison.baselineMean)} · ${signedDelta}`;
}

function formatContextValue(value: number, options: BaselineContextFormatOptions): string {
  if (options.formatter) return options.formatter(value).text;
  return `${formatNumber(value)}${options.unit ? ` ${options.unit}` : ""}`;
}

export function formatBaselineContext(
  metric: BaselineContextMetric,
  options: BaselineContextFormatOptions = {},
): string {
  const parts: string[] = [];
  if (metric.baseline.mean != null) {
    const standardDeviation =
      metric.baseline.standardDeviation != null
        ? ` ± ${formatContextValue(metric.baseline.standardDeviation, options)}`
        : "";
    parts.push(
      `${metric.baseline.windowDays}d baseline ${formatContextValue(metric.baseline.mean, options)}${standardDeviation}`,
    );
  }
  if (metric.baseline.zScore != null) {
    const direction =
      metric.baseline.zScore > 0 ? "above" : metric.baseline.zScore < 0 ? "below" : "at";
    parts.push(`${Math.abs(metric.baseline.zScore).toFixed(1)} SD ${direction} baseline`);
  }
  if (metric.comparison.delta != null) {
    const sign = metric.comparison.delta > 0 ? "+" : "";
    parts.push(
      `${metric.comparison.recentDays}d vs prior ${metric.comparison.baselineDays}d ${sign}${formatContextValue(metric.comparison.delta, options)}`,
    );
  }
  parts.push(`${metric.baseline.sampleCount}/${metric.baseline.windowDays} baseline days`);
  return parts.join(" · ");
}
