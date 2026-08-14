import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import BehaviorAssociationsScreen from "../app/behavior-associations";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";

type BehaviorAssociationsScenario = "available" | "empty";

const associations = [
  {
    questionSlug: "meditation",
    displayName: "Meditation",
    category: "wellness",
    impactPercent: 18.6,
    yesCount: 18,
    noCount: 24,
    sources: [{ providerId: "manual_review", label: "Manual review" }],
    association: {
      relationship: "descriptive_association",
      direction: "higher",
      estimateLabel: "18.6% higher",
      method: "Relative difference in mean next-day readiness after Yes versus No.",
      interpretation:
        "This observational association does not establish that the behavior caused the readiness difference or prescribe a behavior change.",
      uncertainty: "Uncertainty interval is unavailable for this descriptive comparison.",
      observationWindow: "90 days",
    },
  },
  {
    questionSlug: "late-meal",
    displayName: "Late meal",
    category: "nutrition",
    impactPercent: -12.4,
    yesCount: 14,
    noCount: 28,
    sources: [
      { providerId: "manual_review", label: "Manual review" },
      { providerId: "whoop", label: "WHOOP (Cloud)" },
    ],
    association: {
      relationship: "descriptive_association",
      direction: "lower",
      estimateLabel: "12.4% lower",
      method: "Relative difference in mean next-day readiness after Yes versus No.",
      interpretation:
        "This observational association does not establish that the behavior caused the readiness difference or prescribe a behavior change.",
      uncertainty: "Uncertainty interval is unavailable for this descriptive comparison.",
      observationWindow: "90 days",
    },
  },
];

function formatObservationWindow(days: number | null): string {
  return days === null ? "all available history" : `${days} days`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function selectedDaysFromInput(input: unknown): number | null {
  if (!isRecord(input)) return 90;
  const days = input.days;
  if (days === null || typeof days === "number") return days;
  return "json" in input ? selectedDaysFromInput(input.json) : 90;
}

function associationsForWindow(observationWindow: string) {
  return associations.map((association) => ({
    ...association,
    association: { ...association.association, observationWindow },
  }));
}

function createMockLink(scenario: BehaviorAssociationsScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario, op.input);
}

function createMockObservable(
  path: string,
  scenario: BehaviorAssociationsScenario,
  input: unknown,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "behaviorImpact.impactSummary") {
        observer.next?.({
          result: {
            data:
              scenario === "available"
                ? associationsForWindow(formatObservationWindow(selectedDaysFromInput(input)))
                : [],
          },
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
