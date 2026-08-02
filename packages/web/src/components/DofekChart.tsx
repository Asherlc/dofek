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
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { useTodayQueryDate } from "../hooks/useTodayQueryDate.ts";
import { useFetchingCount } from "../lib/FetchingContext.tsx";
import type { TimeRangeDays } from "../lib/timeRange.ts";
import {
  addChartAria,
  buildChartSummary,
  buildChartTable,
  hasChartTableData,
} from "./chart-accessibility.ts";
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
  const contextValue = useMemo(() => ({ days, endDate }), [days, endDate]);
  return <ChartRangeContext.Provider value={contextValue}>{children}</ChartRangeContext.Provider>;
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
  const chartSummary = buildChartSummary(chartOption);
  const accessibleChartOption = addChartAria(chartOption, chartSummary);

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
          option={{ backgroundColor: "transparent", ...accessibleChartOption }}
          style={{ height, width: "100%" }}
          notMerge={true}
          opts={opts}
          onEvents={onEvents}
        />
      </div>
      <ChartDataDisclosure option={chartOption} summary={chartSummary} />
    </QueryErrorBoundary>
  );
}

function ChartDataDisclosure({
  option,
  summary,
}: {
  option: Record<string, unknown>;
  summary: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const table = useMemo(() => (expanded ? buildChartTable(option) : null), [expanded, option]);

  return (
    <div className="mt-2 space-y-1">
      <p className="text-xs text-dim">{summary}</p>
      {hasChartTableData(option) && (
        <details
          onToggle={(event) => setExpanded(event.currentTarget.open)}
          className="text-xs text-dim"
        >
          <summary className="cursor-pointer select-none font-medium text-foreground">
            View chart data
          </summary>
          {table !== null && (
            <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">{summary}</caption>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Series
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      {table.categoryHeader}
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row) => (
                    <tr
                      key={`${row.series}-${row.category}-${row.value}`}
                      className="border-t border-border"
                    >
                      <th scope="row" className="px-3 py-2 font-medium">
                        {row.series}
                      </th>
                      <td className="px-3 py-2">{row.category}</td>
                      <td className="px-3 py-2 font-mono">{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}
    </div>
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
  if (axis.min != null || axis.max != null) return axis;
  return { ...axis, min: bounds.min, max: bounds.max };
}

function isChartAxis(
  axis: unknown,
): axis is Record<string, unknown> & { type?: unknown; min?: unknown; max?: unknown } {
  return typeof axis === "object" && axis !== null;
}
