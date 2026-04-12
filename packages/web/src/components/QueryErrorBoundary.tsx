import { QueryErrorResetBoundary } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

/**
 * Pairs React Query's error reset mechanism with our ErrorBoundary.
 *
 * When a query with `throwOnError: true` (the global default) fails,
 * the error propagates to the nearest ErrorBoundary. Clicking "Try again"
 * resets both the ErrorBoundary state and the React Query error cache,
 * so the failed query is retried on re-render.
 */
export function QueryErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => <ErrorBoundary onReset={reset}>{children}</ErrorBoundary>}
    </QueryErrorResetBoundary>
  );
}
