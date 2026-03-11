import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { createTRPCClient, trpc } from "./lib/trpc.ts";
import { Dashboard } from "./pages/Dashboard.tsx";
import { InsightsPage } from "./pages/InsightsPage.tsx";
import { LogsPage } from "./pages/LogsPage.tsx";

type Route = "dashboard" | "insights" | "logs";

function getRoute(): Route {
  const hash = window.location.hash.slice(1);
  if (hash === "insights") return "insights";
  if (hash === "logs") return "logs";
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

export function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(createTRPCClient);
  const route = useRoute();

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {route === "insights" ? <InsightsPage /> : route === "logs" ? <LogsPage /> : <Dashboard />}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
