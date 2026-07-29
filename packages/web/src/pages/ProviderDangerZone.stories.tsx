import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { ProviderDangerZone } from "./ProviderDangerZone.tsx";

function createMockLink(): TRPCLink<AppRouter> {
  return () => () =>
    createMockObservable({ success: true, operationId: "30000000-0000-4000-8000-000000000001" });
}

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

function StoryFrame() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[640px] p-6">
          <ProviderDangerZone canDisconnect providerId="garmin" providerName="Garmin" />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Providers/ProviderDangerZone",
  component: ProviderDangerZone,
} satisfies Meta<typeof ProviderDangerZone>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DisconnectConfirmation: Story = {
  args: { canDisconnect: true, providerId: "garmin", providerName: "Garmin" },
  render: () => <StoryFrame />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Disconnect Garmin" }));
  },
};

export const DeletionConfirmation: Story = {
  args: { canDisconnect: true, providerId: "garmin", providerName: "Garmin" },
  render: () => <StoryFrame />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Delete all data" }));
  },
};
