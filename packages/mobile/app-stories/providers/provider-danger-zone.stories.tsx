import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { ProviderDangerZone } from "../../components/providers/provider-danger-zone";
import { trpc } from "../../lib/trpc";

function createMockLink(): TRPCLink<AppRouter> {
  return () => () => createMockObservable();
}

function createMockObservable(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data: null } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function StoryFrame({ canDisconnect }: { canDisconnect: boolean }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 360, padding: 16 }}>
          <ProviderDangerZone
            canDisconnect={canDisconnect}
            providerId="garmin"
            providerName="Garmin"
          />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Providers/ProviderDangerZone",
  component: ProviderDangerZone,
  args: {
    canDisconnect: true,
    providerId: "garmin",
    providerName: "Garmin",
  },
} satisfies Meta<typeof ProviderDangerZone>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Connected: Story = {
  render: () => <StoryFrame canDisconnect />,
};

export const DisconnectedWithRetainedData: Story = {
  args: { canDisconnect: false },
  render: () => <StoryFrame canDisconnect={false} />,
};
