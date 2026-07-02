import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { DashboardLayoutProvider } from "./components/DashboardLayoutProvider.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { UnitProvider } from "./components/UnitProvider.tsx";
import { FetchingProvider } from "./lib/FetchingContext.tsx";
import { capturePageView, initPostHog } from "./lib/posthog.ts";
import { QUERY_CACHE_GC_TIME_MS } from "./lib/query-persistence.ts";
import { createTRPCClient, trpc } from "./lib/trpc.ts";
import { routeTree } from "./routeTree.gen.ts";

initPostHog();

const router = createRouter({ routeTree });

router.subscribe("onResolved", () => {
  capturePageView();
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5 min — health data only changes on sync
            gcTime: QUERY_CACHE_GC_TIME_MS,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [trpcClient] = useState(createTRPCClient);

  return (
    <ErrorBoundary>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <FetchingProvider>
            <UnitProvider>
              <DashboardLayoutProvider>
                <RouterProvider router={router} />
              </DashboardLayoutProvider>
            </UnitProvider>
          </FetchingProvider>
        </QueryClientProvider>
      </trpc.Provider>
      <div className="fixed bottom-1 right-1 font-mono text-[10px] text-dim opacity-30 hover:opacity-100 select-all transition-opacity">
        {__COMMIT_HASH__}
      </div>
    </ErrorBoundary>
  );
}
