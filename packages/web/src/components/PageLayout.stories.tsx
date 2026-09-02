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
import { PageLayout } from "./PageLayout.tsx";

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
  "/settings",
  "/admin",
] as const;

function withRouter(Story: ComponentType) {
  const rootRoute = createRootRoute({ component: Outlet });
  const routes = storyPaths.map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => <Story />,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/dashboard"] }),
  });

  return <RouterProvider router={router} />;
}

const content = (
  <div className="grid gap-4 sm:grid-cols-2">
    <section className="card p-5">
      <p className="text-xs uppercase tracking-wide text-subtle">Weekly load</p>
      <p className="mt-2 text-3xl font-semibold text-foreground">7.4 hrs</p>
      <p className="mt-1 text-sm text-muted">Across five activities</p>
    </section>
    <section className="card p-5">
      <p className="text-xs uppercase tracking-wide text-subtle">Consistency</p>
      <p className="mt-2 text-3xl font-semibold text-foreground">86%</p>
      <p className="mt-1 text-sm text-muted">Six-week rolling average</p>
    </section>
  </div>
);

const meta = {
  title: "Layout/PageLayout",
  component: PageLayout,
  tags: ["autodocs"],
  decorators: [withRouter],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    title: "Training",
    subtitle: "Review volume, intensity, and recent activity.",
    headerChildren: (
      <button
        type="button"
        className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-on-accent"
      >
        Add activity
      </button>
    ),
    children: content,
  },
} satisfies Meta<typeof PageLayout>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1, name: "Training" })).toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "Dofek" })).not.toBeInTheDocument();
  },
};

export const WithTabs: Story = {
  args: {
    tabs: [
      { to: "/dashboard", label: "Overview", exact: true },
      { to: "/activities", label: "Activities", exact: false },
      { to: "/training", label: "Insights", exact: false },
    ],
  },
};

export const ContentOnly: Story = {
  args: {
    title: undefined,
    subtitle: undefined,
    headerChildren: undefined,
  },
};

export const SystemAppearance: Story = {
  args: {
    tabs: [
      { to: "/dashboard", label: "Overview", exact: true },
      { to: "/activities", label: "Activities", exact: false },
      { to: "/training", label: "Insights", exact: false },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          "Representative application shell for auditing the browser's light and dark system appearances.",
      },
    },
  },
};
