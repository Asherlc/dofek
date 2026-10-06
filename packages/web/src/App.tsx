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
let navigationInput: { href: string; startedAt: number; event: Event } | undefined;
router.subscribe("onBeforeNavigate", ({ toLocation }) => {
  const input = navigationInput;
  navigationInput = undefined;
  const startedAt =
    input &&
    input.event.eventPhase !== Event.NONE &&
    input.href === new URL(toLocation.href, window.location.href).href
      ? input.startedAt
      : performance.now();
  if (initialNavigationResolved) recordPageNavigationStart(startedAt);
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
    let expiry: number | undefined;
    const captureNavigationInput = (href: string, event: Event) => {
      const input = { href, startedAt: event.timeStamp, event };
      navigationInput = input;
      if (expiry !== undefined) window.clearTimeout(expiry);
      // Native dispatch can run microtasks between capture and router listeners.
      // eventPhase rejects ended dispatch immediately; the task only releases the reference.
      expiry = window.setTimeout(() => {
        if (navigationInput === input) navigationInput = undefined;
        expiry = undefined;
      }, 0);
    };
    const captureInput = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (
        anchor &&
        anchor.origin === window.location.origin &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.defaultPrevented &&
        (!anchor.target || anchor.target === "_self") &&
        !anchor.hasAttribute("download") &&
        event.button === 0
      )
        captureNavigationInput(anchor.href, event);
    };
    const captureHistory = (event: PopStateEvent) => {
      captureNavigationInput(window.location.href, event);
    };
    document.addEventListener("click", captureInput, true);
    window.addEventListener("popstate", captureHistory, true);
    return () => {
      document.removeEventListener("click", captureInput, true);
      window.removeEventListener("popstate", captureHistory, true);
      if (expiry !== undefined) window.clearTimeout(expiry);
      navigationInput = undefined;
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
