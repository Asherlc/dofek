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
import { type LandingPageProvider, LandingPageView } from "./LandingPage.tsx";

const configuredProviders: LandingPageProvider[] = [
  { id: "apple_health", name: "Apple Health", authType: "file-import", importOnly: true },
  { id: "strava", name: "Strava", authType: "oauth", importOnly: false },
  { id: "garmin", name: "Garmin", authType: "custom:garmin", importOnly: false },
  { id: "whoop", name: "WHOOP", authType: "custom:whoop", importOnly: false },
  { id: "oura", name: "Oura", authType: "oauth", importOnly: false },
  { id: "fitbit", name: "Fitbit", authType: "oauth", importOnly: false },
  { id: "peloton", name: "Peloton", authType: "credential", importOnly: false },
  { id: "wahoo", name: "Wahoo", authType: "oauth", importOnly: false },
  { id: "strong-csv", name: "Strong CSV", authType: "file-import", importOnly: true },
  { id: "cronometer-csv", name: "Cronometer CSV", authType: "file-import", importOnly: true },
];

const importOnlyProviders: LandingPageProvider[] = [
  { id: "apple_health", name: "Apple Health", authType: "file-import", importOnly: true },
  { id: "strong-csv", name: "Strong CSV", authType: "file-import", importOnly: true },
  { id: "cronometer-csv", name: "Cronometer CSV", authType: "file-import", importOnly: true },
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
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "login",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([homeRoute, loginRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return (
    <div className="w-screen bg-page">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Pages/LandingPage",
  component: LandingPageView,
  tags: ["autodocs"],
  decorators: [withRouter],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    usableProviders: configuredProviders,
  },
} satisfies Meta<typeof LandingPageView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const ConfiguredProviders: Story = {};

export const ImportOnlyProviders: Story = {
  args: {
    usableProviders: importOnlyProviders,
  },
};

export const NoUsableProviders: Story = {
  args: {
    usableProviders: [],
  },
};
