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
import { expect, within } from "storybook/test";
import { AppHeader } from "./AppHeader";

const storyPaths = [
  "/dashboard",
  "/alerts",
  "/training",
  "/activities",
  "/sleep",
  "/nutrition",
  "/body",
  "/correlation",
  "/tracking",
  "/health-report",
  "/weekly-report",
  "/monthly-report",
  "/more",
  "/settings",
  "/admin",
] as const;

function withRouter(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const routes = storyPaths.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: path === "/dashboard" ? () => <Story /> : () => null,
    }),
  );
  const routeTree = rootRoute.addChildren(routes);
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

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Dofek")).toHaveLength(2);
    await expect(canvas.queryByRole("heading", { name: "Dofek" })).not.toBeInTheDocument();
  },
};

export const MobileNavigationOpen: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Toggle navigation menu" }),
    );
  },
};

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

export const WithActiveAlerts: Story = {
  args: {
    activeAlertCount: 3,
  },
};
