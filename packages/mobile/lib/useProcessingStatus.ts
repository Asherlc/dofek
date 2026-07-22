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
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);
  return trpc.processing.status.useQuery(input, {
    refetchInterval: (query) =>
      foreground ? processingPollInterval(query.state.data?.overallStatus ?? "ready") : false,
    refetchIntervalInBackground: false,
  });
}
