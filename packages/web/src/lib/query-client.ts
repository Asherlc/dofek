import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { captureException } from "./telemetry.ts";

export const locallyReportedErrorMeta = Object.freeze({
  errorReportedLocally: true,
});

function isReportedLocally(meta: Record<string, unknown> | undefined): boolean {
  return meta?.errorReportedLocally === true;
}

function operationFromKey(key: readonly unknown[] | undefined): string {
  const path = key?.[0];
  if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) {
    return "unknown";
  }
  return path.join(".");
}

export function createAppQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        if (isReportedLocally(query.meta)) {
          return;
        }
        captureException(error, {
          source: "react-query-query",
          operation: operationFromKey(query.queryKey),
          failureCount: query.state.fetchFailureCount,
        });
      },
    }),
    mutationCache: new MutationCache({
      onError(error, _variables, _onMutateResult, mutation) {
        if (isReportedLocally(mutation.meta)) {
          return;
        }
        captureException(error, {
          source: "react-query-mutation",
          operation: operationFromKey(mutation.options.mutationKey),
        });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 0,
        gcTime: 1000 * 60 * 5,
        refetchOnWindowFocus: false,
        retry: false,
      },
    },
  });
}
