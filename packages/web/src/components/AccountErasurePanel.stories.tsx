import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { OperationResultObservable, TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { AccountErasurePanel } from "./AccountErasurePanel.tsx";

function createMockLink(): TRPCLink<AppRouter> {
  return () => () => createMockObservable({});
}

function createMockObservable(data: unknown): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      observer.next?.({ result: { data } });
      observer.complete?.();
      return { unsubscribe: () => undefined };
    },
    pipe() {
      return result;
    },
  };
  return result;
}

function StoryFrame() {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink()] }), []);
  const router = useMemo(() => {
    const rootRoute = createRootRoute({ component: Outlet });
    const panelRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => (
        <div className="w-[620px] rounded-xl border border-border bg-surface p-5">
          <AccountErasurePanel />
        </div>
      ),
    });
    return createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([panelRoute]),
    });
  }, []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/AccountErasurePanel",
  component: AccountErasurePanel,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AccountErasurePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <StoryFrame />,
};

export const ConfirmationDisclosure: Story = {
  render: () => <StoryFrame />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "Delete account" }));
  },
};
