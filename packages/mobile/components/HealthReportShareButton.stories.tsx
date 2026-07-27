import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { AuthProvider } from "../lib/auth-context";
import { trpc } from "../lib/trpc";
import { HealthReportShareButton } from "./HealthReportShareButton";

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
      reportType: "monthly",
      reportData: {},
      expiresAt: "2026-08-02T12:00:00.000Z",
      createdAt: "2026-07-24T12:00:00.000Z",
    });
}

function StoryFrame({ input }: React.ComponentProps<typeof HealthReportShareButton>) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <AuthProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <View style={{ padding: 24 }}>
            <HealthReportShareButton input={input} />
          </View>
        </QueryClientProvider>
      </trpc.Provider>
    </AuthProvider>
  );
}

const meta = {
  title: "Reports/HealthReportShareButton",
  component: HealthReportShareButton,
  args: {
    input: { reportType: "monthly", months: 6 },
  },
  render: (args) => <StoryFrame {...args} />,
} satisfies Meta<typeof HealthReportShareButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};
