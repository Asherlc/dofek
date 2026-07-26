import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import {
  CredentialAuthModal,
  GarminAuthModal,
  TokenAuthModal,
  WhoopAuthModal,
} from "./DataSourcesAuthModals.tsx";

function createMockLink(): TRPCLink<AppRouter> {
  return () => () =>
    createMockObservable({ status: "success", token: { accessToken: "story-token" } });
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

function AuthStoryFrame({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Auth/CredentialAuthModal",
  component: CredentialAuthModal,
  args: {
    providerId: "test-provider",
    providerName: "Test Provider",
    onClose: () => {},
    onSuccess: () => {},
  },
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <AuthStoryFrame>
        <Story />
      </AuthStoryFrame>
    ),
  ],
} satisfies Meta<typeof CredentialAuthModal>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDescription: Story = {
  args: {
    description:
      "This provider requires your device serial number. Find it on the back of your device or in the companion app settings.",
  },
};

export const Garmin: Story = {
  render: () => <GarminAuthModal onClose={() => {}} onSuccess={() => {}} />,
};

export const Whoop: Story = {
  render: () => <WhoopAuthModal onClose={() => {}} onSuccess={() => {}} />,
};

export const PersonalToken: Story = {
  render: () => (
    <TokenAuthModal
      providerId="wger"
      providerName="Wger"
      tokenLabel="JWT refresh token"
      instructionsUrl="https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens"
      onClose={() => {}}
      onSuccess={() => {}}
    />
  ),
};
