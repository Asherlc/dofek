import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { MedicationDoseEventsPanel } from "./MedicationDoseEventsPanel";

type MedicationDoseEventsStoryScenario =
  | { kind: "default" }
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "loading" };

const defaultEvents = {
  events: [
    {
      id: "event-1",
      providerId: "apple_health",
      medicationName: "Metformin 500 mg",
      medicationConceptId: "rxnorm-123",
      doseStatus: "taken",
      recordedAt: "2026-06-29T15:30:00.000Z",
      sourceName: "Apple Health",
    },
    {
      id: "event-2",
      providerId: "apple_health",
      medicationName: "Vitamin D",
      medicationConceptId: null,
      doseStatus: "skipped",
      recordedAt: "2026-06-28T16:00:00.000Z",
      sourceName: "Apple Health",
    },
  ],
};

function createMockLink(scenario: MedicationDoseEventsStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(resolveOperation(op.path, scenario), scenario);
}

function createMockObservable(
  data: unknown,
  scenario: MedicationDoseEventsStoryScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (scenario.kind === "loading") return { unsubscribe: () => {} };
      if (scenario.kind === "error") {
        observer.error?.(
          TRPCClientError.from(new Error("Medication dose events are unavailable.")),
        );
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
}

function resolveOperation(path: string, scenario: MedicationDoseEventsStoryScenario): unknown {
  if (path !== "medicationDoseEvents.list") return null;
  if (scenario.kind === "empty") return { events: [] };
  return defaultEvents;
}

function MedicationDoseEventsStoryFrame({
  scenario,
}: {
  scenario: MedicationDoseEventsStoryScenario;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 360, padding: 16 }}>
          <MedicationDoseEventsPanel />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/MedicationDoseEventsPanel",
  component: MedicationDoseEventsPanel,
} satisfies Meta<typeof MedicationDoseEventsPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <MedicationDoseEventsStoryFrame scenario={{ kind: "default" }} />,
};

export const Empty: Story = {
  render: () => <MedicationDoseEventsStoryFrame scenario={{ kind: "empty" }} />,
};

export const Loading: Story = {
  render: () => <MedicationDoseEventsStoryFrame scenario={{ kind: "loading" }} />,
};

export const ErrorState: Story = {
  render: () => <MedicationDoseEventsStoryFrame scenario={{ kind: "error" }} />,
};
