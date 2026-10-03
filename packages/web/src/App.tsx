import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DataConnectionBanner } from "./components/DataConnectionBanner.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { FetchingProvider } from "./lib/FetchingContext.tsx";
import { recordPageNavigationStart } from "./lib/page-load-context.tsx";
import { capturePageView, initPostHog } from "./lib/posthog.ts";
import { createAppQueryClient } from "./lib/query-client.ts";
import { createTRPCClient, trpc } from "./lib/trpc.ts";
import { routeTree } from "./routeTree.gen.ts";

initPostHog();

const router = createRouter({ routeTree });
let initialNavigationResolved = false;
let navigationInputTime: number | undefined;
router.subscribe("onBeforeNavigate", () => {
  if (initialNavigationResolved)
    recordPageNavigationStart(navigationInputTime ?? performance.now());
  navigationInputTime = undefined;
});

router.subscribe("onResolved", () => {
  capturePageView();
  initialNavigationResolved = true;
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  const [queryClient] = useState(createAppQueryClient);
  const [trpcClient] = useState(createTRPCClient);
  useEffect(() => {
    const captureInput = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (
        anchor &&
        anchor.origin === window.location.origin &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.button === 0
      )
        navigationInputTime = event.timeStamp;
    };
    const captureHistory = (event: PopStateEvent) => {
      navigationInputTime = event.timeStamp;
    };
    document.addEventListener("click", captureInput, true);
    window.addEventListener("popstate", captureHistory);
    return () => {
      document.removeEventListener("click", captureInput, true);
      window.removeEventListener("popstate", captureHistory);
    };
  }, []);

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
