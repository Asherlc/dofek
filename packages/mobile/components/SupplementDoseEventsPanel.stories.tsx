import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { SupplementDoseEventsPanel } from "./SupplementDoseEventsPanel";

type Scenario = "default" | "empty" | "loading" | "error";

function createMockLink(scenario: Scenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path !== "supplements.occurrences") {
            observer.error?.(TRPCClientError.from(new Error(`Unexpected operation: ${op.path}`)));
            return { unsubscribe: () => {} };
          }
          if (scenario === "loading" && op.path === "supplements.occurrences") {
            return { unsubscribe: () => {} };
          }
          if (scenario === "error" && op.path === "supplements.occurrences") {
            observer.error?.(
              TRPCClientError.from(new Error("Supplement dose history is unavailable.")),
            );
            return { unsubscribe: () => {} };
          }
          observer.next?.({
            result: {
              data:
                scenario === "empty"
                  ? {
                      occurrences: [],
                      counts: { planned: 0, taken: 0, skipped: 0, unknown: 0 },
                    }
                  : {
                      occurrences: [
                        {
                          currentEventId: "event-current",
                          scheduleId: "schedule-1",
                          supplementId: "supplement-1",
                          supplementName: "Vitamin D",
                          scheduledDate: "2026-07-27",
                          status: "unknown",
                          history: [
                            {
                              id: "event-current",
                              providerId: "auto-supplements",
                              status: "unknown",
                              recordedAt: "2026-07-27T12:00:00.000Z",
                              sourceName: "Auto-Supplements",
                            },
                          ],
                        },
                      ],
                      counts: { planned: 0, taken: 0, skipped: 0, unknown: 1 },
                    },
            },
          });
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function StoryFrame({ scenario }: { scenario: Scenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ padding: 16, width: 360 }}>
          <SupplementDoseEventsPanel />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Nutrition/SupplementDoseEventsPanel",
  component: SupplementDoseEventsPanel,
} satisfies Meta<typeof SupplementDoseEventsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <StoryFrame scenario="default" /> };
export const Empty: Story = { render: () => <StoryFrame scenario="empty" /> };
export const Loading: Story = { render: () => <StoryFrame scenario="loading" /> };
export const ErrorState: Story = { render: () => <StoryFrame scenario="error" /> };
