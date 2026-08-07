import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { SlackIntegrationPanel } from "./SlackIntegrationPanel.tsx";

interface SlackScenario {
  data?: {
    configured: boolean;
    connected: boolean;
  };
  loading?: boolean;
  error?: boolean;
}

function createMockLink(scenario: SlackScenario): TRPCLink<AppRouter> {
  return () => () =>
    scenario.loading
      ? createLoadingObservable()
      : scenario.error
        ? createErrorObservable()
        : createMockObservable(scenario.data);
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

function createLoadingObservable(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe() {
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function createErrorObservable(): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.error?.(new TRPCClientError("Slack status is temporarily unavailable."));
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function SlackStory({ scenario }: { scenario: SlackScenario }) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[640px] rounded-xl border border-border bg-surface p-5">
          <SlackIntegrationPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/SlackIntegrationPanel",
  component: SlackIntegrationPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof SlackIntegrationPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <SlackStory scenario={{ data: { configured: true, connected: false } }} />,
};

export const Connected: Story = {
  render: () => <SlackStory scenario={{ data: { configured: true, connected: true } }} />,
};

export const Loading: Story = {
  render: () => <SlackStory scenario={{ loading: true }} />,
};

export const Unconfigured: Story = {
  render: () => <SlackStory scenario={{ data: { configured: false, connected: false } }} />,
};

export const ErrorState: Story = {
  name: "Error",
  render: () => <SlackStory scenario={{ error: true }} />,
};
