import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { ZeppPairingCard, ZeppPairingCardBody } from "./ZeppPairingCard";

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

function ZeppPairingCardStoryFrame() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <StoryFrame>
          <ZeppPairingCard />
        </StoryFrame>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function StoryFrame({ children }: { children: ReactNode }) {
  return <View style={{ width: 360, padding: 16 }}>{children}</View>;
}

const noop = () => {};

const meta = {
  title: "Settings/ZeppPairingCard",
  component: ZeppPairingCard,
} satisfies Meta<typeof ZeppPairingCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <ZeppPairingCardStoryFrame />,
};

export const Empty: Story = {
  render: () => (
    <StoryFrame>
      <ZeppPairingCardBody
        connections={[]}
        connectionsError={null}
        disconnectError={null}
        isConnectionsLoading={false}
        pairingCode=""
        pairingMessage=""
        isError={false}
        isPending={false}
        onPairingCodeChange={noop}
        onClaimPairing={noop}
        onDisconnect={noop}
      />
    </StoryFrame>
  ),
};

export const Loading: Story = {
  render: () => (
    <StoryFrame>
      <ZeppPairingCardBody
        connections={[{ connectionType: "zepp-main" }]}
        connectionsError={null}
        disconnectError={null}
        isConnectionsLoading
        pairingCode="ABC234"
        pairingMessage=""
        isError={false}
        isPending
        onPairingCodeChange={noop}
        onClaimPairing={noop}
        onDisconnect={noop}
      />
    </StoryFrame>
  ),
};

export const Success: Story = {
  render: () => (
    <StoryFrame>
      <ZeppPairingCardBody
        connections={[{ connectionType: "zepp-main" }, { connectionType: "zepp-workout" }]}
        connectionsError={null}
        disconnectError={null}
        isConnectionsLoading={false}
        pairingCode=""
        pairingMessage="Zepp app connected. Return to Zepp to sync."
        isError={false}
        isPending={false}
        onPairingCodeChange={noop}
        onClaimPairing={noop}
        onDisconnect={noop}
      />
    </StoryFrame>
  ),
};

export const ErrorState: Story = {
  render: () => (
    <StoryFrame>
      <ZeppPairingCardBody
        connections={[]}
        connectionsError="Failed to load Zepp connections."
        disconnectError={null}
        isConnectionsLoading={false}
        pairingCode="ABC234"
        pairingMessage="Pairing code has already been used."
        isError
        isPending={false}
        onPairingCodeChange={noop}
        onClaimPairing={noop}
        onDisconnect={noop}
      />
    </StoryFrame>
  ),
};
