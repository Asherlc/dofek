/**
 * Provides the global React Query fetching count to chart components.
 *
 * Charts use this to show loading skeletons (instead of "No data") when data
 * is empty but a background fetch is in progress, and to show a subtle refresh
 * spinner when data is present but stale.
 *
 * Using a context (rather than calling useIsFetching directly in DofekChart)
 * avoids requiring a QueryClientProvider in every unit test that renders a chart.
 * Tests get the default value of 0; the real app wraps with FetchingProvider.
 */
import { useIsFetching } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext } from "react";

const FetchingContext = createContext(0);

export function FetchingProvider({ children }: { children: ReactNode }) {
  const count = useIsFetching();
  return <FetchingContext.Provider value={count}>{children}</FetchingContext.Provider>;
}

export function useFetchingCount(): number {
  return useContext(FetchingContext);
}
