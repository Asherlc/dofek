import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { SupportPanel } from "./SupportPanel.tsx";

type SupportScenario = "success" | "error" | "pending";

function createMockLink(scenario: SupportScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      createMockObservable(op.path, scenario);
}

function createMockObservable(
  path: string,
  scenario: SupportScenario,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (path === "support.createTicket") {
        if (scenario === "pending") {
          return { unsubscribe: () => {} };
        }
        if (scenario === "error") {
          observer.error?.(new TRPCClientError("We couldn't submit your request right now."));
          return { unsubscribe: () => {} };
        }
        observer.next?.({ result: { data: { ticketId: "ticket-1042" } } });
      }
      observer.complete?.();
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function SupportStoryFrame({ scenario }: { scenario: SupportScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="w-[560px] p-4">
          <SupportPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Components/SupportPanel",
  component: SupportPanel,
} satisfies Meta<typeof SupportPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <SupportStoryFrame scenario="pending" />,
};

export const Failed: Story = {
  render: () => <SupportStoryFrame scenario="error" />,
};
