import { processingPollInterval } from "@dofek/providers/processing-status";
import { trpc } from "../lib/trpc.ts";

export function useProcessingAlerts() {
  return trpc.processing.alerts.useQuery(undefined, {
    refetchInterval: processingPollInterval("failed"),
  });
}
