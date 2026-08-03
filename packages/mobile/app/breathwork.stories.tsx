import { TECHNIQUES, toBreathworkTechniqueDetails } from "@dofek/scoring/breathwork";
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
            result: { data: resolveOperation(op.path) },
          });
          observer.complete?.();
          return { unsubscribe() {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function resolveOperation(path: string): unknown {
  if (path === "breathwork.techniques") return TECHNIQUES.map(toBreathworkTechniqueDetails);
  if (path === "breathwork.outcomes") {
    return {
      windowDays: 30,
      windowKind: "rolling-instant",
      techniques: [
        {
          techniqueId: "box-breathing",
          sessionCount: 5,
          stress: { reportCount: 4, lowerCount: 3, sameCount: 1, higherCount: 0 },
          perceivedEffect: { reportCount: 5, betterCount: 4, sameCount: 1, worseCount: 0 },
          dizziness: { reportCount: 5, yesCount: 1 },
        },
      ],
    };
  }
  if (path === "breathwork.logSession") {
    return {
      id: "story-breathwork-session",
      techniqueId: "box-breathing",
      rounds: 4,
      durationSeconds: 64,
      startedAt: "2026-07-27T12:00:00.000Z",
      notes: null,
      stressBefore: 7,
      stressAfter: 3,
      dizzinessAfter: false,
      perceivedEffect: "better",
    };
  }
  throw new Error(`Unhandled breathwork story tRPC operation: ${path}`);
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
