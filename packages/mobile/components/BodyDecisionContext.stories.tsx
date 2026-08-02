import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { trpc } from "../lib/trpc";
import { BodyDecisionContext } from "./BodyDecisionContext";

function createSettingsLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path === "settings.get") {
            observer.next?.({ result: { data: { key: "unitSystem", value: "metric" } } });
            observer.complete?.();
          } else {
            observer.error?.(new Error(`Unhandled BodyDecisionContext story path: ${op.path}`));
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

function StoryFrame({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createSettingsLink()] }), []);
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Body/BodyDecisionContext",
  component: BodyDecisionContext,
  decorators: [
    (Story) => (
      <StoryFrame>
        <Story />
      </StoryFrame>
    ),
  ],
} satisfies Meta<typeof BodyDecisionContext>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Available: Story = {
  args: {
    context: {
      latestMeasurement: {
        recordedAtLocal: "2026-07-25 08:00:00",
        weightKg: 80,
        providerId: "withings",
        sourceName: "Body+",
      },
      variation: {
        status: "available",
        observations: 12,
        minimumObservations: 8,
        maximumObservations: 30,
        lowerResidualKg: -0.4,
        upperResidualKg: 0.6,
      },
    },
  },
};

export const InsufficientData: Story = {
  args: {
    context: {
      latestMeasurement: null,
      variation: {
        status: "insufficient_data",
        observations: 4,
        minimumObservations: 8,
        maximumObservations: 30,
        lowerResidualKg: null,
        upperResidualKg: null,
      },
    },
  },
};
