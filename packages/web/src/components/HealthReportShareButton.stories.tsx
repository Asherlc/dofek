import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { HealthReportShareButton } from "./HealthReportShareButton.tsx";

function createMockObservable(data: unknown): OperationResultObservable<AppRouter, unknown> {
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
}

function createMockLink(): TRPCLink<AppRouter> {
  return () => () =>
    createMockObservable({
      id: "report-story",
      shareToken: "story-token",
      reportType: "weekly",
      reportData: {},
      expiresAt: "2026-08-02T12:00:00.000Z",
      createdAt: "2026-07-24T12:00:00.000Z",
    });
}

function StoryFrame({ input }: React.ComponentProps<typeof HealthReportShareButton>) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="bg-page p-6">
          <HealthReportShareButton input={input} />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Reports/HealthReportShareButton",
  component: HealthReportShareButton,
  args: {
    input: { reportType: "weekly", weeks: 12, endDate: "2026-07-24" },
  },
  render: (args) => <StoryFrame {...args} />,
} satisfies Meta<typeof HealthReportShareButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};
