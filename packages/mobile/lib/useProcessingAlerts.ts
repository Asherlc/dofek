import { processingPollInterval } from "@dofek/providers/processing-status";
import { trpc } from "./trpc";

export function useProcessingAlerts() {
  return trpc.processing.alerts.useQuery(undefined, {
    refetchInterval: processingPollInterval("failed"),
    refetchIntervalInBackground: false,
  });
}
