/**
 * Standard chart wrapper. Handles loading skeletons, empty states,
 * and consistent sizing so individual charts only define their ECharts option.
 *
 * Usage:
 *   <DofekChart
 *     option={option}
 *     loading={query.isLoading}
 *     empty={data.length === 0}
 *     height={250}
 *     emptyMessage="No sleep data yet"
 *   />
 */
import ReactECharts from "echarts-for-react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface DofekChartProps {
  option: Record<string, unknown>;
  loading?: boolean;
  empty?: boolean;
  height?: number;
  emptyMessage?: string;
  /** Pass ECharts opts like { renderer: "svg" } */
  opts?: Record<string, unknown>;
}

export function DofekChart({
  option,
  loading,
  empty,
  height = 250,
  emptyMessage = "No data available",
  opts,
}: DofekChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={height} />;
  }

  if (empty) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-dim text-sm">{emptyMessage}</span>
      </div>
    );
  }

  return (
    <ReactECharts
      option={{ backgroundColor: "transparent", ...option }}
      style={{ height, width: "100%" }}
      notMerge={true}
      opts={opts}
    />
  );
}
