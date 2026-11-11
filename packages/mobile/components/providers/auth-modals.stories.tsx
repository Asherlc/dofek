import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { CredentialAuthModal, TokenAuthModal } from "./auth-modals.tsx";

function connectionResult(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data: { success: true } } });
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

const meta = {
  title: "Providers/TokenAuthModal",
  component: TokenAuthModal,
  decorators: [
    (Story) => {
      const queryClient = useMemo(() => new QueryClient(), []);
      const client = useMemo(
        () =>
          trpc.createClient({
            links: [() => () => connectionResult()],
          }),
        [],
      );
      return (
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <Story />
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
  args: {
    kind: "access-token",
    providerId: "thecrag",
    providerName: "theCrag",
    tokenLabel: "Personal API key",
    instructionsUrl: "https://www.thecrag.com/en/article/logbookreadapi",
    onClose: () => {},
    onSuccess: () => {},
  },
} satisfies Meta<typeof TokenAuthModal>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const BoardUsername: Story = {
  render: () => (
    <CredentialAuthModal
      providerId="tension"
      providerName="Tension Board"
      onClose={() => {}}
      onSuccess={() => {}}
    />
  ),
};
export const WithDescription: Story = {
  args: {
    description:
      "Requires an active theCrag supporter subscription. This key imports public and private ascents and notes into Dofek. Revoke it in theCrag Settings > API Keys when you stop using it.",
  },
};
