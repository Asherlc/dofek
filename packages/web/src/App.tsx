import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { DataConnectionBanner } from "./components/DataConnectionBanner.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { FetchingProvider } from "./lib/FetchingContext.tsx";
import { capturePageView, initPostHog } from "./lib/posthog.ts";
import { createAppQueryClient } from "./lib/query-client.ts";
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
  const [queryClient] = useState(createAppQueryClient);
  const [trpcClient] = useState(createTRPCClient);

  return (
    <ErrorBoundary>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <DataConnectionBanner />
          <FetchingProvider>
            <RouterProvider router={router} />
          </FetchingProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ErrorBoundary>
  );
}
