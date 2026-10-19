import { QueryClient } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import type { ClimbingAttachmentActivity } from "../../server/src/contracts/climbing-log-contracts.ts";
import { trpc } from "../lib/trpc";

export const climbingAttachmentSafeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
};

export const climbingAttachmentActivities: ClimbingAttachmentActivity[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Evening bouldering",
    activityType: "climbing",
    providerId: "garmin",
    startTime: "18:30",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: null,
    activityType: "hiking",
    providerId: "apple_health",
    startTime: "09:15",
  },
];

export interface ClimbingAttachmentFixtureOptions {
  activities?: ClimbingAttachmentActivity[];
  loading?: boolean;
  queryError?: string;
  mutationError?: string;
  mutationPending?: boolean;
}

export function createClimbingAttachmentTestClient({
  activities = climbingAttachmentActivities,
  loading = false,
  queryError,
  mutationError,
  mutationPending = false,
}: ClimbingAttachmentFixtureOptions = {}) {
  let currentActivities = activities;
  const requests: Array<{ path: string; input: unknown }> = [];
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 300_000, refetchOnMount: false },
      mutations: { retry: false },
    },
  });
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          requests.push({ path: op.path, input: op.input });
          if (op.path === "climbing.attachmentActivities") {
            if (!loading) {
              if (queryError) observer.error?.(new TRPCClientError(queryError));
              else {
                observer.next?.({ result: { data: currentActivities } });
                observer.complete?.();
              }
            }
          } else if (op.path === "climbing.attachClimbingLogEntry") {
            if (!mutationPending) {
              if (mutationError) observer.error?.(new TRPCClientError(mutationError));
              else {
                observer.next?.({ result: { data: { attached: true } } });
                observer.complete?.();
              }
            }
          } else {
            observer.error?.(
              new TRPCClientError(`Unhandled climbing attachment fixture: ${op.path}`),
            );
          }
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
  return {
    queryClient,
    client: trpc.createClient({ links: [link] }),
    requests,
    setActivities: (updated: ClimbingAttachmentActivity[]) => {
      currentActivities = updated;
    },
  };
}
