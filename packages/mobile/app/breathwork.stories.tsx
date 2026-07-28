import { TECHNIQUES } from "@dofek/scoring/breathwork";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { colors } from "../theme";
import BreathworkScreen from "./breathwork";

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          observer.next?.({
            result: { data: op.path === "breathwork.techniques" ? TECHNIQUES : null },
          });
          observer.complete?.();
          return { unsubscribe() {} };
        },
      };
      return result;
    };
}

function BreathworkStoryFrame() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
    [],
  );
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <BreathworkScreen />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Breathwork",
  component: BreathworkScreen,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof BreathworkScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SafetyGuidance: Story = {
  render: () => <BreathworkStoryFrame />,
};
