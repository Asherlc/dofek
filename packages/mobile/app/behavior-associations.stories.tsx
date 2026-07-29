import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import BehaviorAssociationsScreen from "./behavior-associations";

type BehaviorAssociationsScenario = "available" | "empty";

const associations = [
  {
    questionSlug: "meditation",
    displayName: "Meditation",
    category: "wellness",
    impactPercent: 18.6,
    yesCount: 18,
    noCount: 24,
  },
  {
    questionSlug: "late-meal",
    displayName: "Late meal",
    category: "nutrition",
    impactPercent: -12.4,
    yesCount: 14,
    noCount: 28,
  },
];

function createMockLink(scenario: BehaviorAssociationsScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: BehaviorAssociationsScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "behaviorImpact.impactSummary") {
        observer.next?.({
          result: { data: scenario === "available" ? associations : [] },
        });
      }
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function BehaviorAssociationsStoryFrame({ scenario }: { scenario: BehaviorAssociationsScenario }) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <BehaviorAssociationsScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/BehaviorAssociations",
  component: BehaviorAssociationsScreen,
} satisfies Meta<typeof BehaviorAssociationsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  render: () => <BehaviorAssociationsStoryFrame scenario="available" />,
};

export const Empty: Story = {
  render: () => <BehaviorAssociationsStoryFrame scenario="empty" />,
};
