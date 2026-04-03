/**
 * Standard chart wrapper. Handles loading skeletons, empty states,
 * and consistent sizing so individual charts only define their ECharts option.
 *
 * Usage:
 *   <DofekChart
 *     option={option}
 *     loading={query.isLoading}
 *     fetching={query.isFetching}
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
  /** Background refetch in progress (from query.isFetching). When true and
   *  data is empty, shows a skeleton instead of "No data". When true with
   *  data present, shows a subtle refresh indicator over the chart. */
  fetching?: boolean;
  empty?: boolean;
  height?: number;
  emptyMessage?: string;
  /** Pass ECharts opts like { renderer: "svg" } */
  opts?: Record<string, unknown>;
}

export function DofekChart({
  option,
  loading,
  fetching,
  empty,
  height = 250,
  emptyMessage = "No data available",
  opts,
}: DofekChartProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={height} />;
  }

  if (empty) {
    // Data is empty but a refetch is running — show skeleton, not "No data"
    if (fetching) {
      return <ChartLoadingSkeleton height={height} />;
    }
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-dim text-sm">{emptyMessage}</span>
      </div>
    );
  }

  return (
    <div className="relative" style={{ height }}>
      {fetching && (
        <div className="absolute top-2 right-2 z-10">
          <div className="w-3.5 h-3.5 border-2 border-border-strong border-t-muted rounded-full animate-spin" />
        </div>
      )}
      <ReactECharts
        option={{ backgroundColor: "transparent", ...option }}
        style={{ height, width: "100%" }}
        notMerge={true}
        opts={opts}
      />
    </div>
  );
}
