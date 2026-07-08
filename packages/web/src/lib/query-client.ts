import { QueryCache, QueryClient } from "@tanstack/react-query";
import { captureException } from "./telemetry.ts";

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
        staleTime: 0,
        gcTime: 0,
        refetchOnWindowFocus: false,
      },
    },
  });
}
