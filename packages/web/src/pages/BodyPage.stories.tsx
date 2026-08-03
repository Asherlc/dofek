import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { UnitProvider } from "../components/UnitProvider.tsx";
import { BodyDaysContext } from "../lib/bodyDaysContext.ts";
import { trpc } from "../lib/trpc.ts";
import { BodyPage } from "./BodyPage.tsx";

const bodyDependencyPaths = new Set([
  "dailyMetrics.trends",
  "dailyMetrics.list",
  "dailyMetrics.hrvBaseline",
  "stress.scores",
  "bodyAnalytics.weightOverview",
  "insights.compute",
]);

function createBodyErrorLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createBodyErrorObservable(op.path);
}

function createBodyErrorObservable(path: string): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (bodyDependencyPaths.has(path)) {
        observer.error?.(
          TRPCClientError.from<AppRouter>(new Error("Body analytics are temporarily unavailable.")),
        );
        return { unsubscribe: () => {} };
      }

      if (path === "settings.get") {
        observer.next?.({ result: { data: { key: "goalWeight", value: null } } });
        observer.complete?.();
        return { unsubscribe: () => {} };
      }

      observer.error?.(
        TRPCClientError.from<AppRouter>(new Error(`Unhandled Body story tRPC path: ${path}`)),
      );
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function BodyErrorStoryFrame() {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    [],
  );
  const trpcClient = useMemo(() => trpc.createClient({ links: [createBodyErrorLink()] }), []);
  const bodyDays = useMemo(
    () => ({
      days: 30,
      description: "Recommended default: 30 days keeps recent body changes visible.",
      setDays: () => {},
    }),
    [],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <UnitProvider settingsEnabled={false}>
          <BodyDaysContext.Provider value={bodyDays}>
            <main className="min-h-screen bg-background p-4 text-foreground">
              <BodyPage />
            </main>
          </BodyDaysContext.Provider>
        </UnitProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Body",
  component: BodyPage,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof BodyPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ConsolidatedDependencyError: Story = {
  render: () => <BodyErrorStoryFrame />,
  tags: ["review-scenario-error"],
};
