/**
 * Standard chart wrapper. Handles loading skeletons, empty states,
 * and consistent sizing so individual charts only define their ECharts option.
 *
 * Automatically detects background fetching via React Query's useIsFetching():
 * - Empty data + fetch in progress → loading skeleton (not "No data")
 * - Data present + fetch in progress → subtle refresh spinner overlay
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
import { useFetchingCount } from "../lib/FetchingContext.tsx";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface DofekChartProps {
  option: Record<string, unknown>;
  loading?: boolean;
  empty?: boolean;
  height?: number;
  emptyMessage?: string;
  /** Pass ECharts opts like { renderer: "svg" } */
  opts?: Record<string, unknown>;
  /** ECharts event handlers passed to ReactECharts */
  onEvents?: Record<string, (...params: Array<Record<string, unknown>>) => void>;
}

export function DofekChart({
  option,
  loading,
  empty,
  height = 250,
  emptyMessage = "No data available",
  opts,
  onEvents,
}: DofekChartProps) {
  const fetchingCount = useFetchingCount();

  if (loading) {
    return <ChartLoadingSkeleton height={height} />;
  }

  if (empty) {
    // Data is empty but a refetch is running — show skeleton, not "No data"
    if (fetchingCount > 0) {
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
      {fetchingCount > 0 && (
        <div className="absolute top-2 right-2 z-10">
          <div className="w-3.5 h-3.5 border-2 border-border-strong border-t-muted rounded-full animate-spin" />
        </div>
      )}
      <ReactECharts
        option={{ backgroundColor: "transparent", ...option }}
        style={{ height, width: "100%" }}
        notMerge={true}
        opts={opts}
        onEvents={onEvents}
      />
    </div>
  );
}
