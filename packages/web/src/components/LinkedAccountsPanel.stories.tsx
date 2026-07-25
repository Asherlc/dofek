import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { trpc } from "../lib/trpc.ts";
import { LinkedAccountsPanel } from "./LinkedAccountsPanel.tsx";

interface LinkedAccountsScenario {
  accounts: unknown[];
  state?: "ready" | "loading" | "error";
}

const accounts = [
  {
    id: "account-google",
    authProvider: "google",
    email: "runner@example.com",
    name: "Avery Runner",
    createdAt: "2026-01-10",
    canUnlink: false,
    unlinkReason: "Cannot unlink your only login method",
  },
  {
    id: "account-garmin",
    authProvider: "garmin",
    email: null,
    name: null,
    createdAt: "2026-02-04",
    canUnlink: true,
    unlinkReason: null,
  },
];

function createMockLink(scenario: LinkedAccountsScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path !== "auth.linkedAccounts") return createMockObservable({ ok: true });
      if (scenario.state === "loading") return createLoadingObservable();
      if (scenario.state === "error") return createErrorObservable();
      return createMockObservable(scenario.accounts);
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
      observer.error?.(new TRPCClientError("Linked accounts are temporarily unavailable."));
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function LinkedAccountsStory({ scenario }: { scenario: LinkedAccountsScenario }) {
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
        <div className="w-[620px] rounded-xl border border-border bg-surface p-5">
          <LinkedAccountsPanel />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function installConfiguredProvidersFetch(): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : input.toString();
    if (new URL(requestUrl, "http://localhost").pathname === "/api/auth/providers") {
      return new Response(
        JSON.stringify({
          identity: ["google", "apple"],
          data: ["garmin", "strava"],
          password: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return previousFetch(input, init);
  };
  return () => {
    globalThis.fetch = previousFetch;
  };
}

const meta = {
  title: "Settings/LinkedAccountsPanel",
  component: LinkedAccountsPanel,
  tags: ["autodocs"],
  beforeEach: installConfiguredProvidersFetch,
} satisfies Meta<typeof LinkedAccountsPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <LinkedAccountsStory scenario={{ accounts }} />,
};

export const Loading: Story = {
  render: () => <LinkedAccountsStory scenario={{ accounts: [], state: "loading" }} />,
};

export const Empty: Story = {
  render: () => <LinkedAccountsStory scenario={{ accounts: [] }} />,
};

export const ErrorState: Story = {
  name: "Error",
  render: () => <LinkedAccountsStory scenario={{ accounts: [], state: "error" }} />,
};
