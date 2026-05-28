import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { ComponentType } from "react";
import { AppHeader } from "./AppHeader";

function withRouter(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/dashboard",
    component: () => <Story />,
  });
  const routeTree = rootRoute.addChildren([dashboardRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
  });

  return (
    <div className="min-h-screen bg-page">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Layout/AppHeader",
  component: AppHeader,
  tags: ["autodocs"],
  decorators: [withRouter],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AppHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const EmptyNoUser: Story = {
  name: "No user",
};

export const LoadingShell: Story = {
  args: {
    children: (
      <output className="inline-block h-7 w-20 animate-pulse rounded-md bg-skeleton">
        <span className="sr-only">Loading header action</span>
      </output>
    ),
  },
};

export const WithHeaderAction: Story = {
  args: {
    children: (
      <button
        type="button"
        className="rounded-md border border-border bg-surface-solid px-3 py-1.5 text-xs font-semibold text-foreground"
      >
        30 days
      </button>
    ),
  },
};
