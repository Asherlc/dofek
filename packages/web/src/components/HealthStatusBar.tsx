import {
  type FormattedMeasurement,
  type FormattedMeasurementFormatter,
  type FormattedMeasurementPart,
  formatNumber,
} from "@dofek/format/format";
import { useCountUp } from "../hooks/useCountUp.ts";

interface HealthMetric {
  label: string;
  value: number | null | undefined;
  avg: number | null | undefined;
  stddev: number | null | undefined;
  unit?: string;
  formatValue?: FormattedMeasurementFormatter;
  /** Whether lower is better (e.g., resting HR) */
  lowerBetter?: boolean;
}

interface HealthStatusBarProps {
  metrics: HealthMetric[];
  loading?: boolean;
}

function getStatus(
  value: number | null | undefined,
  avg: number | null | undefined,
  stddev: number | null | undefined,
  lowerBetter?: boolean,
): "green" | "yellow" | "red" | "unknown" {
  if (value == null || avg == null || stddev == null || stddev === 0) return "unknown";
  const rawZScore = (value - avg) / stddev;

  // When we know the direction, deviations in the "good" direction stay green
  if (lowerBetter !== undefined) {
    const isBadDirection = lowerBetter ? rawZScore > 0 : rawZScore < 0;
    if (!isBadDirection) return "green";
  }

  const absZScore = Math.abs(rawZScore);
  if (absZScore < 1) return "green";
  if (absZScore < 2) return "yellow";
  return "red";
}

const statusColors = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
  unknown: "bg-dim",
};

const statusText = {
  green: "Normal",
  yellow: "Elevated",
  red: "Abnormal",
  unknown: "—",
};

function MetricValue({ value }: { value: number | null | undefined }) {
  const decimals = value != null && !Number.isInteger(value) ? 1 : 0;
  const display = useCountUp(value ?? null, 600, decimals);

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

function MetricDisplay({ metric }: { metric: HealthMetric }) {
  if (metric.formatValue) {
    const display = metric.formatValue(metric.value);

    return <>{renderMeasurementParts(display)}</>;
  }

  return (
    <>
      <MetricValue value={metric.value} />
      {metric.value != null && metric.unit && (
        <span className="ml-1 text-xs font-normal text-subtle">{metric.unit}</span>
      )}
    </>
  );
}

function formatAverage(metric: HealthMetric): string {
  if (metric.avg == null) return "";
  if (!metric.formatValue) return formatNumber(Number(metric.avg));

  const display = metric.formatValue(metric.avg);
  return display.text;
}

export function HealthStatusBar({ metrics, loading }: HealthStatusBarProps) {
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
        const status = getStatus(metric.value, metric.avg, metric.stddev, metric.lowerBetter);
        return (
          <div
            key={metric.label}
            className="flex-1 min-w-[120px] card card-hover p-3 stagger-fade-in"
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${statusColors[status]}`} />
              <span className="text-xs text-muted uppercase tracking-wider">{metric.label}</span>
            </div>
            <div className="text-lg font-semibold font-mono tabular-nums">
              <MetricDisplay metric={metric} />
            </div>
            <div className="text-[10px] text-subtle">
              {status !== "unknown" && metric.avg != null
                ? `avg ${formatAverage(metric)} · ${statusText[status]}`
                : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
