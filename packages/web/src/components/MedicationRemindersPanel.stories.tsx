import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { MedicationRemindersPanel } from "./MedicationRemindersPanel.tsx";

type MedicationRemindersStoryScenario =
  | { kind: "default" }
  | { kind: "empty" }
  | { kind: "error" }
  | { kind: "loading" };

const defaultReminders = {
  key: "medicationReminders",
  value: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      medicationName: "Vitamin D3",
      localTime: "08:30",
      enabled: true,
    },
  ],
};

const defaultEvents = {
  events: [
    {
      id: "event-1",
      providerId: "apple_health",
      medicationName: "Vitamin D3",
      medicationConceptId: null,
      doseStatus: "taken",
      recordedAt: "2026-07-25T16:00:00.000Z",
      sourceName: "Apple Health",
    },
  ],
};

function createMockLink(scenario: MedicationRemindersStoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(resolveOperation(op.path, scenario), scenario);
}

function createMockObservable(
  data: unknown,
  scenario: MedicationRemindersStoryScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (scenario.kind === "loading") return { unsubscribe: () => {} };
      if (scenario.kind === "error") {
        observer.error?.(TRPCClientError.from(new Error("Medication reminders are unavailable.")));
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

function resolveOperation(path: string, scenario: MedicationRemindersStoryScenario): unknown {
  if (path === "settings.get") {
    if (scenario.kind === "empty") {
      return { key: "medicationReminders", value: [] };
    }
    return defaultReminders;
  }
  if (path === "medicationDoseEvents.list") {
    return defaultEvents;
  }
  return null;
}

function MedicationRemindersStoryFrame({
  scenario,
}: {
  scenario: MedicationRemindersStoryScenario;
}) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[520px] p-4">
          <MedicationRemindersPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/MedicationRemindersPanel",
  component: MedicationRemindersPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof MedicationRemindersPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <MedicationRemindersStoryFrame scenario={{ kind: "default" }} />,
};

export const Empty: Story = {
  render: () => <MedicationRemindersStoryFrame scenario={{ kind: "empty" }} />,
};

export const Loading: Story = {
  render: () => <MedicationRemindersStoryFrame scenario={{ kind: "loading" }} />,
};

export const ErrorState: Story = {
  render: () => <MedicationRemindersStoryFrame scenario={{ kind: "error" }} />,
};
