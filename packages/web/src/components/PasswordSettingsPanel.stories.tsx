import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { PasswordSettingsPanel } from "./PasswordSettingsPanel.tsx";

interface PasswordScenario {
  hasPassword: boolean;
  state?: "ready" | "loading" | "error";
}

function createMockLink(scenario: PasswordScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path !== "auth.passwordCredentialStatus") {
        return createMockObservable({ ok: true });
      }
      if (scenario.state === "loading") return createLoadingObservable();
      if (scenario.state === "error") return createErrorObservable();
      return createMockObservable({ hasPassword: scenario.hasPassword });
    };
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
      observer.error?.(new TRPCClientError("Password status is temporarily unavailable."));
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function PasswordStory({ scenario }: { scenario: PasswordScenario }) {
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
        <div className="w-[560px] rounded-xl border border-border bg-surface p-5">
          <PasswordSettingsPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/PasswordSettingsPanel",
  component: PasswordSettingsPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof PasswordSettingsPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <PasswordStory scenario={{ hasPassword: false }} />,
};

export const ExistingPassword: Story = {
  render: () => <PasswordStory scenario={{ hasPassword: true }} />,
};

export const Loading: Story = {
  render: () => <PasswordStory scenario={{ hasPassword: false, state: "loading" }} />,
};

export const ErrorState: Story = {
  name: "Error",
  render: () => <PasswordStory scenario={{ hasPassword: false, state: "error" }} />,
};
