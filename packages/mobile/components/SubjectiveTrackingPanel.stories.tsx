import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel";

type SubjectiveStoryScenario = "empty" | "injuries" | "error" | "loading";

const regions = [{ id: "left_hand", label: "Left hand", kind: "hand", parent_id: null }];

function createMockLink(scenario: SubjectiveStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (scenario === "loading") return { unsubscribe: () => {} };
          if (scenario === "error") {
            observer.error?.(TRPCClientError.from(new Error("Subjective data is unavailable.")));
            return { unsubscribe: () => {} };
          }
          const data =
            op.path === "subjective.regions"
              ? regions
              : op.path === "subjective.injuries"
                ? scenario === "injuries"
                  ? [
                      {
                        id: "injury-story",
                        kind: "niggle",
                        body_region_id: "left_hand",
                        onset_date: "2026-08-01",
                        resolved_date: null,
                        severity: 3,
                        description: "Morning tenderness",
                        created_at: "2026-08-01T08:00:00.000Z",
                        updated_at: "2026-08-01T08:00:00.000Z",
                      },
                    ]
                  : []
                : null;
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
}

function SubjectiveStoryFrame({ scenario }: { scenario: SubjectiveStoryScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 360, padding: 16 }}>
          <SubjectiveTrackingPanel />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Tracking/SubjectiveTrackingPanel",
  component: SubjectiveTrackingPanel,
} satisfies Meta<typeof SubjectiveTrackingPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => <SubjectiveStoryFrame scenario="empty" />,
  tags: ["review-scenario", "review-scenario-empty-data"],
};

export const InjuriesPresent: Story = {
  render: () => <SubjectiveStoryFrame scenario="injuries" />,
};

export const Loading: Story = {
  render: () => <SubjectiveStoryFrame scenario="loading" />,
  tags: ["review-scenario", "review-scenario-loading"],
};

export const ErrorState: Story = {
  render: () => <SubjectiveStoryFrame scenario="error" />,
  tags: ["review-scenario", "review-scenario-error"],
};
