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
import { ProviderGuide } from "./ProviderGuide";

const providerCatalog = [
  { id: "strava", name: "Strava", authorized: false },
  { id: "garmin", name: "Garmin", authorized: false },
  { id: "wahoo", name: "Wahoo", authorized: false },
  { id: "polar", name: "Polar", authorized: false },
  { id: "fitbit", name: "Fitbit", authorized: false },
  { id: "zwift", name: "Zwift", authorized: false },
  { id: "peloton", name: "Peloton", authorized: false },
  { id: "oura", name: "Oura", authorized: false },
  { id: "whoop", name: "WHOOP", authorized: false },
  { id: "eight-sleep", name: "Eight Sleep", authorized: false },
  { id: "cronometer-csv", name: "Cronometer", authorized: false },
  { id: "fatsecret", name: "FatSecret", authorized: false },
  { id: "withings", name: "Withings", authorized: false },
  { id: "ultrahuman", name: "Ultrahuman", authorized: false },
];

function withRouter(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <Story />,
  });
  const providersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "providers",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([homeRoute, providersRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <div className="w-screen max-w-5xl p-6">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Providers/ProviderGuide",
  component: ProviderGuide,
  tags: ["autodocs"],
  decorators: [withRouter],
  args: {
    providers: providerCatalog,
    onDismiss: () => {},
  },
} satisfies Meta<typeof ProviderGuide>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LimitedProviders: Story = {
  args: {
    providers: providerCatalog.filter((provider) =>
      ["strava", "garmin", "oura", "whoop", "withings"].includes(provider.id),
    ),
  },
};

export const NoAvailableProviders: Story = {
  args: {
    providers: [],
  },
};
