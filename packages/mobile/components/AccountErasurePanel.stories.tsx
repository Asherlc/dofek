import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { within } from "storybook/test";
import { trpc } from "../lib/trpc";
import { AccountErasurePanel } from "./AccountErasurePanel";

type AccountErasureScenario = "accepted" | "uncertain" | "retry";

declare global {
  var __dofekStorybookAccountErasureScenario: AccountErasureScenario | undefined;
  var __dofekStorybookAuth:
    | {
        beginAccountErasureCleanup?: (ownerUserId: string) => {
          cleanupId: number;
          cleanupOwnerNonce: string;
          sessionGeneration: number;
        };
        user?: { id: string; name: string; email: string | null } | null;
      }
    | undefined;
}

function createMockLink(scenario: AccountErasureScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path === "accountErasure.prepare") {
            observer.next?.({
              result: {
                data: {
                  expiresAt: "2026-08-25T12:00:00.000Z",
                  preparationToken: "p".repeat(43),
                },
              },
            });
            observer.complete?.();
          } else if (op.path === "accountErasure.confirm" && scenario === "uncertain") {
            observer.error?.(new Error("Network request failed."));
          } else if (op.path === "accountErasure.confirm") {
            observer.next?.({
              result: {
                data: {
                  replayRetainedUntil: "2026-08-02T12:00:00.000Z",
                  requestId: "11111111-1111-4111-8111-111111111111",
                  retentionUntil: "2026-08-25T12:00:00.000Z",
                  statusToken: "s".repeat(43),
                },
              },
            });
            observer.complete?.();
          } else {
            observer.error?.(new Error(`Unhandled account-erasure story path: ${op.path}`));
          }
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function AccountErasureStoryFrame({ scenario }: { scenario: AccountErasureScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 390 }}>
          <AccountErasurePanel />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function installScenario(scenario: AccountErasureScenario): () => void {
  const previousScenario = globalThis.__dofekStorybookAccountErasureScenario;
  const previousAuth = globalThis.__dofekStorybookAuth;
  globalThis.__dofekStorybookAccountErasureScenario = scenario;
  globalThis.__dofekStorybookAuth = {
    user: { id: "storybook-user", name: "Storybook User", email: "storybook@example.com" },
    ...(scenario === "retry"
      ? {
          beginAccountErasureCleanup: () => {
            throw new Error("Local account cleanup is unavailable.");
          },
        }
      : {}),
  };
  return () => {
    globalThis.__dofekStorybookAccountErasureScenario = previousScenario;
    globalThis.__dofekStorybookAuth = previousAuth;
  };
}

async function prepareAndConfirm(
  canvasElement: HTMLElement,
  userEvent: Story["play"] extends (context: infer Context) => unknown
    ? Context extends { userEvent: infer UserEvent }
      ? UserEvent
      : never
    : never,
) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Delete account" }));
  await userEvent.type(canvas.getByLabelText('Type "DELETE" to continue'), "DELETE");
  await userEvent.click(canvas.getByRole("button", { name: "Prepare account deletion" }));
  await userEvent.click(
    await canvas.findByRole("button", { name: "Permanently delete my account" }),
  );
}

const meta = {
  title: "Settings/AccountErasurePanel",
  component: AccountErasurePanel,
} satisfies Meta<typeof AccountErasurePanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Accepted: Story = {
  beforeEach: () => installScenario("accepted"),
  render: () => <AccountErasureStoryFrame scenario="accepted" />,
  play: async ({ canvasElement, userEvent }) => {
    await prepareAndConfirm(canvasElement, userEvent);
    await within(canvasElement).findByText(
      /Account deletion was accepted and your session was closed/i,
    );
  },
};

export const OutcomeUncertain: Story = {
  beforeEach: () => installScenario("uncertain"),
  render: () => <AccountErasureStoryFrame scenario="uncertain" />,
  play: async ({ canvasElement, userEvent }) => {
    await prepareAndConfirm(canvasElement, userEvent);
    await within(canvasElement).findByText(/We could not confirm the outcome/i);
  },
};

export const Retry: Story = {
  beforeEach: () => installScenario("retry"),
  render: () => <AccountErasureStoryFrame scenario="retry" />,
  play: async ({ canvasElement, userEvent }) => {
    await prepareAndConfirm(canvasElement, userEvent);
    await within(canvasElement).findByText(/Account deletion was not started/i);
  },
};
