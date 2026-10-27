import { QueryClient } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import type { AppRouter } from "dofek-server/router";
import { trpc } from "../lib/trpc.ts";
import { activityPhotoFixture } from "./ActivityPhoto.fixtures.ts";

export type ClimbingPhotosScenario =
  | "stored"
  | "loading"
  | "pending"
  | "empty"
  | "error"
  | "refresh-error"
  | "terminal-error"
  | "incomplete"
  | "incomplete-stored";
export function createClimbingPhotosFixture(scenario: ClimbingPhotosScenario) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const photo = {
    ...activityPhotoFixture,
    sources: [
      {
        activityId: null,
        climbingLogEntryId: "log-1",
        providerId: "kaya",
        sourceId: "ascent-1",
        kind: "photo",
        caption: "The arete",
        position: 0,
      },
    ],
  };
  if (scenario === "refresh-error") {
    queryClient.setQueryData(getQueryKey(trpc.climbing.images, { id: "log-1" }, "query"), {
      images: [photo],
      acquisition: [],
      coverage: [],
    });
  }
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path !== "climbing.images") {
            observer.error?.(new TRPCClientError(`Unexpected fixture query: ${op.path}`));
          } else if (scenario === "loading") {
            return { unsubscribe: () => {} };
          } else if (scenario === "error" || scenario === "refresh-error") {
            observer.error?.(new TRPCClientError("Reconnect to load ascent photos."));
          } else {
            observer.next?.({
              result: {
                data: {
                  images: scenario === "stored" || scenario === "incomplete-stored" ? [photo] : [],
                  coverage: scenario.startsWith("incomplete")
                    ? [
                        {
                          activityId: null,
                          climbingLogEntryId: "log-1",
                          providerId: "kaya",
                          coverage: "partial",
                          reason: "invalid_kaya_ascent_photo",
                          expectedCount: null,
                        },
                      ]
                    : [],
                  acquisition:
                    scenario === "pending" || scenario === "terminal-error"
                      ? [
                          {
                            id: "work-1",
                            state: scenario === "pending" ? "pending" : "terminal_failure",
                            errorCode: null,
                            attempts: 1,
                          },
                        ]
                      : [],
                },
              },
            });
            observer.complete?.();
          }
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
  return { queryClient, client: trpc.createClient({ links: [link] }) };
}
