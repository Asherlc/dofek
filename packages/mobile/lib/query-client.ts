import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { captureException } from "./telemetry";

export function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /network connection was lost|request timed out|network request failed|(?:^|\b)(?:user )?cancel(?:led|ed)\b/i.test(
    message,
  );
}

export function createAppQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        captureException(error, {
          source: "react-query",
          queryHash: query.queryHash,
          failureCount: query.state.fetchFailureCount,
        });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5,
        gcTime: QUERY_CACHE_MAX_AGE_MS,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });
}
