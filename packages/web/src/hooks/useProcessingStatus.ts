import { processingPollInterval } from "@dofek/providers/processing-status";
import { trpc } from "../lib/trpc.ts";

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
  return trpc.processing.status.useQuery(input, {
    refetchInterval: (query) => processingPollInterval(query.state.data?.overallStatus ?? "ready"),
  });
}
