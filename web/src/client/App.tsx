import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createTRPCClient, trpc } from "./lib/trpc.js";
import { Dashboard } from "./pages/Dashboard.js";

export function App() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(createTRPCClient);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </trpc.Provider>
  );
}
