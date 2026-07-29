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
