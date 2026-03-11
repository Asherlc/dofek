import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { createTRPCClient, trpc } from "./lib/trpc.ts";
import { Dashboard } from "./pages/Dashboard.tsx";
import { InsightsPage } from "./pages/InsightsPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";

type Route = "dashboard" | "insights" | "providers";

function getRoute(): Route {
  const hash = window.location.hash.slice(1);
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
  insights: InsightsPage,
  providers: ProvidersPage,
} as const;

export function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(createTRPCClient);
  const route = useRoute();
  const Page = pages[route];

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
