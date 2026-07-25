import {
  type FormattedMeasurement,
  type FormattedMeasurementFormatter,
  type FormattedMeasurementPart,
  formatNumber,
} from "@dofek/format/format";
import { useCountUp } from "../hooks/useCountUp.ts";
import type { HealthMetricKey, HealthStatusMetric } from "../lib/healthStatus.ts";

interface HealthStatusBarProps {
  metrics: HealthStatusMetric[];
  loading?: boolean;
  formatters?: Partial<Record<HealthMetricKey, FormattedMeasurementFormatter>>;
  units?: Partial<Record<HealthMetricKey, string>>;
}

const statusColors: Record<HealthStatusMetric["statusColor"], string> = {
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
  muted: "bg-dim",
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
  return formatter ? formatter(metric.baseline).text : formatNumber(metric.baseline);
}

export function HealthStatusBar({
  metrics,
  loading,
  formatters = {},
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

  return (
    <div className="flex gap-3 overflow-x-auto">
      {metrics.map((metric, index) => {
        const formatter = formatters[metric.metric];
        return (
          <div
            key={metric.metric}
            className="flex-1 min-w-[120px] card card-hover p-3 stagger-fade-in"
            style={{ animationDelay: `${index * 80}ms` }}
            title={metric.explanation}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${statusColors[metric.statusColor]}`} />
              <span className="text-xs text-muted uppercase tracking-wider">{metric.label}</span>
            </div>
            <div className="text-lg font-semibold font-mono tabular-nums">
              <MetricDisplay metric={metric} formatter={formatter} unit={units[metric.metric]} />
            </div>
            <div className="text-[10px] text-subtle">
              {metric.baseline != null
                ? `baseline ${formatBaseline(metric, formatter)} · ${metric.statusLabel}`
                : metric.statusLabel}
            </div>
          </div>
        );
      })}
    </div>
  );
}
