import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { SubjectiveTrackingPanel } from "./SubjectiveTrackingPanel.tsx";

const regions = [
  { id: "left-hand", label: "Left hand", kind: "hand", parent_id: "upper-limb" },
  { id: "right-knee", label: "Right knee", kind: "joint", parent_id: "lower-limb" },
];

function createMockLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      let data: unknown;
      if (op.path === "subjective.regions") data = regions;
      else if (op.path === "subjective.checkIn") data = { logged: true, symptoms: [] };
      else if (op.path === "subjective.injuries") data = [];
      else data = { id: "story-id", perceivedExertion: 7 };

      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
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

function SubjectiveStory() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

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
  render: () => <SubjectiveStory />,
};
