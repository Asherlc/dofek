import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { trpc } from "../../lib/trpc";

export type RestoreStoryScenario = "visible" | "pending" | "error";

function createRestoreMockLink(scenario: RestoreStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path !== "activity.restoreProviderAbsent") {
            throw new globalThis.Error(
              `Unhandled activity detail story tRPC operation: ${op.path}`,
            );
          }
          if (scenario === "pending") return { unsubscribe: () => {} };
          if (scenario === "error") {
            observer.error?.(
              TRPCClientError.from(new globalThis.Error("Provider connection is unavailable")),
            );
          } else {
            observer.next?.({ result: { data: { restoredCount: 1 } } });
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
}

export function ActivityDetailStoryProviders({
  children,
  restoreScenario = "visible",
}: {
  children: ReactNode;
  restoreScenario?: RestoreStoryScenario;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createRestoreMockLink(restoreScenario)] }),
    [restoreScenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
