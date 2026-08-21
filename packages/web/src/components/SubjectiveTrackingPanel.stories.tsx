import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel.tsx";

const regions = [
  { id: "left-hand", label: "Left hand", kind: "hand", parent_id: "upper-limb" },
  { id: "right-knee", label: "Right knee", kind: "joint", parent_id: "lower-limb" },
];

type SubjectiveStoryScenario =
  | "all-clear"
  | "error"
  | "injuries"
  | "loading"
  | "not-logged"
  | "symptoms";

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

          let data: unknown;
          if (op.path === "subjective.regions") data = regions;
          else if (op.path === "subjective.checkIn") {
            data = {
              date: "2026-08-02",
              logged: scenario !== "not-logged",
              symptoms:
                scenario === "symptoms"
                  ? [
                      {
                        id: "symptom-story",
                        body_region_id: "left-hand",
                        kind: "tenderness",
                        score: 4,
                      },
                    ]
                  : [],
            };
          } else if (op.path === "subjective.injuries") {
            data =
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
          } else data = { id: "story-id", perceivedExertion: 7 };

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

export const Default: Story = {
  render: () => <SubjectiveStory scenario="all-clear" />,
};

export const NotLogged: Story = {
  render: () => <SubjectiveStory scenario="not-logged" />,
};

export const SymptomsLogged: Story = {
  render: () => <SubjectiveStory scenario="symptoms" />,
};

export const InjuriesPresent: Story = {
  render: () => <SubjectiveStory scenario="injuries" />,
};

export const Loading: Story = {
  render: () => <SubjectiveStory scenario="loading" />,
};

export const ErrorState: Story = {
  render: () => <SubjectiveStory scenario="error" />,
};
