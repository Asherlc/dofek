import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel.tsx";

type SubjectiveStoryScenario = "empty" | "error" | "injuries" | "loading";

function createMockLink(scenario: SubjectiveStoryScenario): TRPCLink<AppRouter> {
  return () => () => {
    const result: OperationResultObservable<AppRouter, unknown> = {
      subscribe(observer) {
        if (scenario === "loading") return { unsubscribe: () => {} };
        if (scenario === "error") {
          observer.error?.(TRPCClientError.from(new Error("Subjective data is unavailable.")));
          return { unsubscribe: () => {} };
        }

        const data =
          scenario === "injuries"
            ? [
                {
                  id: "injury-story",
                  kind: "niggle",
                  body_region_id: "left-hand",
                  onset_date: "2026-08-01",
                  resolved_date: null,
                  severity: 3,
                  description: "Morning tenderness",
                  created_at: "2026-08-01T08:00:00.000Z",
                  updated_at: "2026-08-01T08:00:00.000Z",
                },
              ]
            : [];

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

function SubjectiveStory({ scenario }: { scenario: SubjectiveStoryScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[820px] rounded-xl border border-border bg-surface p-5">
          <SubjectiveTrackingPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Tracking/SubjectiveTrackingPanel",
  component: SubjectiveTrackingPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof SubjectiveTrackingPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const InjuriesPresent: Story = {
  render: () => <SubjectiveStory scenario="injuries" />,
};

export const Empty: Story = {
  render: () => <SubjectiveStory scenario="empty" />,
  tags: ["review-scenario", "review-scenario-empty-data"],
};

export const Loading: Story = {
  render: () => <SubjectiveStory scenario="loading" />,
};

export const ErrorState: Story = {
  render: () => <SubjectiveStory scenario="error" />,
};
