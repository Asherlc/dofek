import { processingPollInterval } from "@dofek/providers/processing-status";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { trpc } from "./trpc";

export function useProcessingStatus(input: {
  providerId?: string;
  datasets?: Array<
    | "activity"
    | "hiking"
    | "cycling"
    | "sleep"
    | "recovery"
    | "training"
    | "body"
    | "nutrition"
    | "providers"
  >;
}) {
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const query = trpc.processing.status.useQuery(input, {
    refetchInterval: (currentQuery) =>
      foreground
        ? processingPollInterval(currentQuery.state.data?.overallStatus ?? "ready")
        : false,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      setForeground(active);
      if (active) void query.refetch();
    });
    return () => subscription.remove();
  }, [query.refetch]);
  return query;
}
