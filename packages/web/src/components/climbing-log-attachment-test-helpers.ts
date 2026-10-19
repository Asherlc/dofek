import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { z } from "zod";
import type { ClimbingAttachmentActivity } from "../../../server/src/contracts/climbing-log-contracts.ts";
import { createAppQueryClient } from "../lib/query-client.ts";
import { trpc } from "../lib/trpc.ts";
import { climbingLocationMapFixture } from "./climbing-location-map-test-helpers.ts";

export const climbingAttachmentActivities: ClimbingAttachmentActivity[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Morning climbing",
    activityType: "climbing",
    providerId: "garmin",
    startTime: "08:30",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Approach hike",
    activityType: "hiking",
    providerId: "strava",
    startTime: "15:45",
  },
];

export function createClimbingAttachmentFixture(
  options: {
    activities?: ClimbingAttachmentActivity[];
    queryError?: string;
    mutationError?: string;
    pending?: "query" | "mutation";
  } = {},
) {
  const queryClient = createAppQueryClient();
  const requests: Array<{ path: string; input: unknown }> = [];
  let map = climbingLocationMapFixture;
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          requests.push({ path: op.path, input: op.input });
          let data: unknown;
          if (op.path === "climbing.attachmentActivities") {
            if (options.pending === "query") return { unsubscribe: () => {} };
            if (options.queryError) {
              observer.error?.(new TRPCClientError(options.queryError));
              return { unsubscribe: () => {} };
            }
            data = options.activities ?? climbingAttachmentActivities;
          } else if (op.path === "climbing.attachClimbingLogEntry") {
            if (options.pending === "mutation") return { unsubscribe: () => {} };
            if (options.mutationError) {
              observer.error?.(new TRPCClientError(options.mutationError));
              return { unsubscribe: () => {} };
            }
            const input = z
              .object({ climbingLogEntryId: z.string(), activityId: z.string() })
              .parse(op.input);
            map = {
              ...map,
              nodes: map.nodes.map((node) => ({
                ...node,
                entries: node.entries.map((entry) =>
                  entry.id === input.climbingLogEntryId
                    ? { ...entry, activityId: input.activityId }
                    : entry,
                ),
              })),
            };
            data = { attached: true };
          } else if (op.path === "climbing.locationMap") {
            data = map;
          } else {
            observer.error?.(new TRPCClientError(`Unexpected fixture query: ${op.path}`));
            return { unsubscribe: () => {} };
          }
          observer.next?.({ result: { data } });
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
  return { queryClient, client: trpc.createClient({ links: [link] }), requests };
}
