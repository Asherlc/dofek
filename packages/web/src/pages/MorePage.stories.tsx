import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { MorePage } from "./MorePage.tsx";

function MorePageStory() {
  const rootRoute = createRootRoute({ component: Outlet });
  const moreRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/more",
    component: MorePage,
  });
  const destinationRoutes = [
    { path: "/settings", title: "Account & settings" },
    { path: "/data-quality", title: "Data quality" },
    { path: "/cycle", title: "Cycle tracking" },
  ].map(({ path, title }) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => (
        <main className="p-8">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-2 text-muted-foreground">Story destination preview</p>
        </main>
      ),
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([moreRoute, ...destinationRoutes]),
    history: createMemoryHistory({ initialEntries: ["/more"] }),
  });

  return <RouterProvider router={router} />;
}

const meta = {
  title: "Pages/More",
  component: MorePage,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof MorePage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <MorePageStory />,
};
