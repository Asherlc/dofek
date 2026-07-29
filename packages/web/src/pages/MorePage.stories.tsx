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
  const destinationRoutes = ["/settings", "/breathwork", "/cycle"].map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: () => null,
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
