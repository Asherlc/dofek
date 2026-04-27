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
  { id: "strava", name: "Strava", authorized: false, importOnly: false, authType: "oauth" },
  { id: "garmin", name: "Garmin", authorized: false, importOnly: false, authType: "custom:garmin" },
  { id: "wahoo", name: "Wahoo", authorized: false, importOnly: false, authType: "oauth" },
  { id: "polar", name: "Polar", authorized: false, importOnly: false, authType: "oauth" },
  { id: "fitbit", name: "Fitbit", authorized: false, importOnly: false, authType: "oauth" },
  { id: "zwift", name: "Zwift", authorized: false, importOnly: false, authType: "oauth" },
  { id: "peloton", name: "Peloton", authorized: false, importOnly: false, authType: "credential" },
  { id: "oura", name: "Oura", authorized: false, importOnly: false, authType: "oauth" },
  { id: "whoop", name: "WHOOP", authorized: false, importOnly: false, authType: "custom:whoop" },
  {
    id: "eight-sleep",
    name: "Eight Sleep",
    authorized: false,
    importOnly: false,
    authType: "credential",
  },
  {
    id: "cronometer-csv",
    name: "Cronometer",
    authorized: false,
    importOnly: true,
    authType: "file-import",
  },
  { id: "fatsecret", name: "FatSecret", authorized: false, importOnly: false, authType: "oauth" },
  { id: "withings", name: "Withings", authorized: false, importOnly: false, authType: "oauth" },
  {
    id: "ultrahuman",
    name: "Ultrahuman",
    authorized: false,
    importOnly: false,
    authType: "credential",
  },
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

export const UsableProvidersOnly: Story = {
  args: {
    providers: [
      { id: "strava", name: "Strava", authorized: false, importOnly: false, authType: "oauth" },
      {
        id: "cronometer-csv",
        name: "Cronometer",
        authorized: false,
        importOnly: true,
        authType: "file-import",
      },
    ],
  },
};

export const NoAvailableProviders: Story = {
  args: {
    providers: [],
  },
};
