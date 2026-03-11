import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import { createTRPCClient, trpc } from "./lib/trpc.ts";

const Dashboard = lazy(() =>
  import("./pages/Dashboard.tsx").then((m) => ({ default: m.Dashboard })),
);
const InsightsPage = lazy(() =>
  import("./pages/InsightsPage.tsx").then((m) => ({ default: m.InsightsPage })),
);
const ProvidersPage = lazy(() =>
  import("./pages/ProvidersPage.tsx").then((m) => ({ default: m.ProvidersPage })),
);
const TrainingPage = lazy(() =>
  import("./pages/TrainingPage.tsx").then((m) => ({ default: m.TrainingPage })),
);

type Route = "dashboard" | "training" | "insights" | "providers";

function getRoute(): Route {
  const hash = window.location.hash.slice(1);
  if (hash === "training") return "training";
  if (hash === "insights") return "insights";
  if (hash === "providers") return "providers";
  return "dashboard" as Route;
}

function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    getRoute,
    () => "dashboard" as Route,
  );
}

const pages = {
  dashboard: Dashboard,
  training: TrainingPage,
  insights: InsightsPage,
  providers: ProvidersPage,
} as const;

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5 min — health data only changes on sync
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [trpcClient] = useState(createTRPCClient);
  const route = useRoute();
  const Page = pages[route];

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div className="min-h-screen bg-zinc-950" />}>
          <Page />
        </Suspense>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
