/**
 * Standard chart wrapper. Handles loading skeletons, empty states,
 * and consistent sizing so individual charts only define their ECharts option.
 *
 * Automatically detects background fetching via React Query's useIsFetching():
 * - Loading query → loading skeleton
 * - Empty data after this chart loaded → empty message
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

import { formatDateYmd } from "@dofek/format/format";
import ReactECharts from "echarts-for-react";
import { createContext, type ReactNode, useContext } from "react";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { useFetchingCount } from "../lib/FetchingContext.tsx";
import type { TimeRangeDays } from "../lib/timeRange.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";
import { QueryErrorBoundary } from "./QueryErrorBoundary.tsx";

interface ChartRangeContextValue {
  days: TimeRangeDays;
  endDate: string;
}

const ChartRangeContext = createContext<ChartRangeContextValue | null>(null);

export function ChartRangeProvider({
  days,
  children,
}: {
  days: TimeRangeDays;
  children: ReactNode;
}) {
  const endDate = useTodayQueryDate();
  return (
    <ChartRangeContext.Provider value={{ days, endDate }}>{children}</ChartRangeContext.Provider>
  );
}

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
  /** Use "data" for charts whose time axis must stay data-driven. */
  timeRangeMode?: "context" | "data";
}

export function DofekChart({
  option,
  loading,
  empty,
  height = 250,
  emptyMessage = "No data available",
  opts,
  onEvents,
  timeRangeMode = "context",
}: DofekChartProps) {
  const fetchingCount = useFetchingCount();
  const range = useContext(ChartRangeContext);
  const chartOption =
    timeRangeMode === "context" ? applySelectedRangeToTimeAxes(option, range) : option;

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
    <QueryErrorBoundary>
      <div className="relative" style={{ height }}>
        {fetchingCount > 0 && (
          <div className="absolute top-2 right-2 z-10">
            <div className="w-3.5 h-3.5 border-2 border-border-strong border-t-muted rounded-full animate-spin" />
          </div>
        )}
        <ReactECharts
          option={{ backgroundColor: "transparent", ...chartOption }}
          style={{ height, width: "100%" }}
          notMerge={true}
          opts={opts}
          onEvents={onEvents}
        />
      </div>
    </QueryErrorBoundary>
  );
}

function applySelectedRangeToTimeAxes(
  option: Record<string, unknown>,
  range: ChartRangeContextValue | null,
): Record<string, unknown> {
  if (range?.days == null) return option;
  const bounds = selectedRangeBounds(range.days, range.endDate);
  const rangedXAxis = applyBoundsToXAxis(option.xAxis, bounds);
  return rangedXAxis === option.xAxis ? option : { ...option, xAxis: rangedXAxis };
}

function selectedRangeBounds(days: number, endDateYmd: string): { min: string; max: string } {
  const endDate = dateFromYmd(endDateYmd);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days);
  return {
    min: formatDateYmd(startDate),
    max: endDateYmd,
  };
}

function dateFromYmd(dateYmd: string): Date {
  const [yearText, monthText, dayText] = dateYmd.split("-");
  return new Date(Number(yearText), Number(monthText) - 1, Number(dayText));
}

function applyBoundsToXAxis(xAxis: unknown, bounds: { min: string; max: string }): unknown {
  if (Array.isArray(xAxis)) {
    let changed = false;
    const axes = xAxis.map((axis) => {
      const rangedAxis = applyBoundsToTimeAxis(axis, bounds);
      if (rangedAxis !== axis) changed = true;
      return rangedAxis;
    });
    return changed ? axes : xAxis;
  }
  return applyBoundsToTimeAxis(xAxis, bounds);
}

function applyBoundsToTimeAxis(axis: unknown, bounds: { min: string; max: string }): unknown {
  if (!isChartAxis(axis)) return axis;
  if (axis.type !== "time") return axis;
  if (axis.min !== undefined || axis.max !== undefined) return axis;
  return { ...axis, min: bounds.min, max: bounds.max };
}

function isChartAxis(
  axis: unknown,
): axis is Record<string, unknown> & { type?: unknown; min?: unknown; max?: unknown } {
  return typeof axis === "object" && axis !== null;
}
