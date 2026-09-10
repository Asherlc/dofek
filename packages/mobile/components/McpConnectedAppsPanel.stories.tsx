import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { McpConnectedAppsPanel } from "./McpConnectedAppsPanel";

const connectedApps = [
  {
    id: "oauth-token-1",
    name: "Claude OAuth",
    scopes: ["health:read"],
    createdAt: "2026-05-20T12:00:00.000Z",
    lastUsedAt: "2026-05-20T12:30:00.000Z",
    expiresAt: null,
    revokedAt: null,
    oauthClientId: "claude-client",
  },
  {
    id: "oauth-token-2",
    name: "ChatGPT OAuth",
    scopes: ["health:read", "activity:read"],
    createdAt: "2026-05-19T12:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-06-01T00:00:00.000Z",
    revokedAt: null,
    oauthClientId: "chatgpt-client",
  },
];

type StoryScenario = "default" | "loading" | "error" | "empty" | "paginated";

function createMockLink(scenario: StoryScenario): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (op.path === "mcp.listConnectedApps") {
            if (scenario === "loading") return { unsubscribe: () => {} };
            if (scenario === "error") {
              observer.error?.(new Error("Connected apps request failed"));
              return { unsubscribe: () => {} };
            }
            if (scenario === "empty") {
              observer.next?.({ result: { data: { items: [], nextCursor: null } } });
            } else if (scenario === "paginated" && op.input?.cursor) {
              observer.next?.({ result: { data: { items: connectedApps, nextCursor: null } } });
            } else {
              const items =
                scenario === "paginated"
                  ? Array.from({ length: 20 }, (_, index) => ({
                      ...connectedApps[0],
                      id: `oauth-token-${index}`,
                      name: `OAuth app ${index + 1}`,
                    }))
                  : connectedApps;
              observer.next?.({
                result: {
                  data: { items, nextCursor: scenario === "paginated" ? "oauth-token-19" : null },
                },
              });
            }
          } else if (op.path === "mcp.revokeToken") {
            observer.next?.({ result: { data: connectedApps[0] } });
          } else {
            observer.error?.(new Error(`Unhandled MCP story path: ${op.path}`));
            return { unsubscribe: () => {} };
          }
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
}

function StoryFrame({ scenario }: { scenario: StoryScenario }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(
    () => trpc.createClient({ links: [createMockLink(scenario)] }),
    [scenario],
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 390, padding: 16 }}>
          <McpConnectedAppsPanel />
        </View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/McpConnectedAppsPanel",
  component: McpConnectedAppsPanel,
} satisfies Meta<typeof McpConnectedAppsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { render: () => <StoryFrame scenario="default" /> };
export const Loading: Story = { render: () => <StoryFrame scenario="loading" /> };
export const ErrorState: Story = { render: () => <StoryFrame scenario="error" /> };
export const Empty: Story = { render: () => <StoryFrame scenario="empty" /> };
export const Paginated: Story = { render: () => <StoryFrame scenario="paginated" /> };
