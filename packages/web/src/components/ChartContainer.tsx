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
 * - Shows an empty-state message when `data` is empty and not loading.
 * - Renders children when data is present.
 */
export function ChartContainer({
  loading,
  data,
  height = 300,
  emptyMessage = "No data available",
  children,
}: ChartContainerProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={height} />;
  }

  if (data.length === 0) {
    return (
      <div className={`flex items-center justify-center h-[${height}px]`}>
        <span className="text-zinc-600 text-sm">{emptyMessage}</span>
      </div>
    );
  }

  return <>{children}</>;
}
