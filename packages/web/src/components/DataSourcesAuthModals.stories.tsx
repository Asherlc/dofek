import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import {
  CredentialAuthModal,
  GarminAuthModal,
  TokenAuthModal,
  WhoopAuthModal,
} from "./DataSourcesAuthModals.tsx";

type TokenAuthScenario = "success" | "loading" | "error";

function createMockLink(scenario: TokenAuthScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path !== "tokenAuth.connect") {
        return createMockObservable({ status: "success", token: { accessToken: "story-token" } });
      }
      if (scenario === "loading") return createLoadingObservable();
      if (scenario === "error") return createErrorObservable();
      return createMockObservable({ success: true });
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
      observer.error?.(new TRPCClientError("Wger rejected this refresh token."));
      return { unsubscribe: () => {} };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function AuthStoryFrame({
  children,
  tokenAuthScenario,
}: {
  children: ReactNode;
  tokenAuthScenario: TokenAuthScenario;
}) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
    [],
  );
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(tokenAuthScenario)] }),
    [tokenAuthScenario],
  );

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
    (Story, context) => (
      <AuthStoryFrame
        tokenAuthScenario={
          context.parameters.tokenAuthScenario === "loading" ||
          context.parameters.tokenAuthScenario === "error"
            ? context.parameters.tokenAuthScenario
            : "success"
        }
      >
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

export const PersonalTokenLoading: Story = {
  parameters: {
    tokenAuthScenario: "loading",
  },
  render: PersonalToken.render,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.type(canvas.getByLabelText("JWT refresh token"), "story-refresh-token");
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await canvas.findByRole("button", { name: "Connecting..." });
  },
};

export const PersonalTokenError: Story = {
  parameters: {
    tokenAuthScenario: "error",
  },
  render: PersonalToken.render,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.type(canvas.getByLabelText("JWT refresh token"), "rejected-refresh-token");
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await canvas.findByRole("alert");
  },
};
