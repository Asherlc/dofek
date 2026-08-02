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
    <div className="bg-page">
      <RouterProvider router={router} />
    </div>
  );
}

function withFixedMobileViewport(Story: ComponentType) {
  return (
    <div style={{ width: "390px", height: "667px", overflow: "hidden" }}>
      <Story />
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

export const MobileHeader: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  play: async ({ canvasElement }) => {
    const signInLink = within(canvasElement).getByRole("link", { name: "Sign in" });

    await expect(signInLink).toBeVisible();
    await expect(signInLink).toHaveAttribute("href", "/login");
  },
};

export const MobileFirstViewport: Story = {
  name: "Mobile first viewport",
  decorators: [withFixedMobileViewport],
  parameters: {
    docs: {
      description: {
        story:
          "Keeps the concrete recovery outcome visible within a fixed 390 × 667 first-viewport frame.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Today's recovery picture")).toBeVisible();
    await expect(canvas.getByText("74%")).toBeVisible();
    await expect(canvas.getByText("Near baseline")).toBeVisible();
  },
};

export const IllustrativeDecisionPreview: Story = {
  name: "Illustrative decision preview",
  parameters: {
    docs: {
      description: {
        story:
          "Shows the landing-page relationship as an illustrative sample without an unsupported statistical result, sample size, or confidence interval.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("Illustrative relationship")).toBeVisible();
    await expect(canvas.getByText("Illustrative sample")).toBeVisible();
    await expect(canvas.getByText("No measured correlation")).toBeVisible();
    await expect(
      canvas.getByText("No sample size or confidence interval is shown for this illustration."),
    ).toBeVisible();
    await expect(
      canvas.getByRole("img", {
        name: "Illustrative scatter plot for demonstration only. X-axis: Sleep consistency (%). Y-axis: Heart rate variability (ms).",
      }),
    ).toBeVisible();
  },
};

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
