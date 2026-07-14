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
import { FileImportProviderCard } from "./FileImportProviderCard.tsx";

function withRouter(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Story />,
  });
  const providerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "providers/$id",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([homeRoute, providerRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <div className="w-screen max-w-sm p-6">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Providers/FileImportProviderCard",
  component: FileImportProviderCard,
  tags: ["autodocs"],
  decorators: [withRouter],
  args: {
    providerId: "strong-csv",
    title: "Strong",
    description: ".csv export from Strong app",
    accept: ".csv",
    uploadUrl: "/api/upload/strong-csv?units=kg",
    statusUrl: "/api/upload/strong-csv/status",
  },
} satisfies Meta<typeof FileImportProviderCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AppleHealth: Story = {
  args: {
    providerId: "apple_health",
    title: "Apple Health",
    description: ".zip or .xml from Health app export",
    accept: ".zip,.xml",
    uploadUrl: "/api/upload/apple-health?fullSync=true",
    statusUrl: "/api/upload/apple-health/status",
    chunked: true,
  },
};

export const WithoutDetailsLink: Story = {
  args: {
    showDetailsLink: false,
  },
};
