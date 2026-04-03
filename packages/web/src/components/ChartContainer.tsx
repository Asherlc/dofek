import { useIsFetching } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface ChartContainerProps {
  loading: boolean;
  data: unknown[];
  height?: number;
  emptyMessage?: string;
  children: ReactNode;
}

/**
 * Wrapper component that handles loading and empty states for chart components.
 *
 * - Shows a `ChartLoadingSkeleton` spinner when `loading` is true.
 * - Shows a skeleton when data is empty but a background refetch is in progress.
 * - Shows an empty-state message when `data` is empty and not loading/fetching.
 * - Renders children when data is present.
 */
export function ChartContainer({
  loading,
  data,
  height = 300,
  emptyMessage = "No data available",
  children,
}: ChartContainerProps) {
  const fetchingCount = useIsFetching();

  if (loading) {
    return <ChartLoadingSkeleton height={height} />;
  }

  if (data.length === 0) {
    if (fetchingCount > 0) {
      return <ChartLoadingSkeleton height={height} />;
    }
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="text-dim text-sm">{emptyMessage}</span>
      </div>
    );
  }

  return <>{children}</>;
}
