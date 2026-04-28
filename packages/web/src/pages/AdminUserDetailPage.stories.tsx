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
import { type AdminUserDetail, AdminUserDetailContent } from "./AdminUserDetailPage.tsx";

const subscribedUserDetail: AdminUserDetail = {
  profile: {
    id: "00000000-0000-0000-0000-000000000101",
    name: "Alex Rivera",
    email: "alex@example.com",
    birth_date: "1990-05-12",
    is_admin: false,
    created_at: "2026-01-15T17:20:00.000Z",
    updated_at: "2026-04-20T09:45:00.000Z",
  },
  flags: {
    providerGuideDismissed: false,
  },
  billing: {
    user_id: "00000000-0000-0000-0000-000000000101",
    stripe_customer_id: "cus_customer_example",
    stripe_subscription_id: "sub_subscription_example",
    stripe_subscription_status: "active",
    stripe_current_period_end: "2026-05-15T17:20:00.000Z",
    paid_grant_reason: null,
    created_at: "2026-01-15T17:25:00.000Z",
    updated_at: "2026-04-20T09:45:00.000Z",
  },
  access: {
    kind: "full",
    paid: true,
    reason: "stripe_subscription",
  },
  stripeLinks: {
    customer: "https://dashboard.stripe.com/customers/cus_customer_example",
    subscription: "https://dashboard.stripe.com/subscriptions/sub_subscription_example",
  },
  accounts: [
    {
      id: "account-google",
      auth_provider: "google",
      provider_account_id: "google-oauth2|123456",
      email: "alex@example.com",
      name: "Alex Rivera",
      created_at: "2026-01-15T17:20:00.000Z",
    },
    {
      id: "account-slack",
      auth_provider: "slack",
      provider_account_id: "U123456",
      email: "alex@example.com",
      name: "Alex R.",
      created_at: "2026-03-05T14:10:00.000Z",
    },
  ],
  providers: [
    { id: "whoop", name: "WHOOP", created_at: "2026-01-16T08:10:00.000Z" },
    { id: "strava", name: "Strava", created_at: "2026-01-17T10:35:00.000Z" },
    { id: "apple_health", name: "Apple Health", created_at: "2026-02-02T19:00:00.000Z" },
  ],
  sessions: [
    {
      id: "session_example_recent",
      created_at: "2026-04-27T15:30:00.000Z",
      expires_at: "2026-05-27T15:30:00.000Z",
    },
    {
      id: "session_example_previous",
      created_at: "2026-04-12T11:05:00.000Z",
      expires_at: "2026-05-12T11:05:00.000Z",
    },
  ],
};

const localGrantUserDetail: AdminUserDetail = {
  ...subscribedUserDetail,
  profile: {
    ...subscribedUserDetail.profile,
    id: "00000000-0000-0000-0000-000000000102",
    name: "Morgan Lee",
    email: "morgan@example.com",
    is_admin: true,
  },
  flags: {
    providerGuideDismissed: true,
  },
  billing: {
    user_id: "00000000-0000-0000-0000-000000000102",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_subscription_status: null,
    stripe_current_period_end: null,
    paid_grant_reason: "admin_grant",
    created_at: "2026-01-15T17:25:00.000Z",
    updated_at: "2026-04-20T09:45:00.000Z",
  },
  access: {
    kind: "full",
    paid: true,
    reason: "paid_grant",
  },
  stripeLinks: {
    customer: null,
    subscription: null,
  },
};

const limitedUserDetail: AdminUserDetail = {
  ...subscribedUserDetail,
  profile: {
    ...subscribedUserDetail.profile,
    id: "00000000-0000-0000-0000-000000000103",
    name: "Jamie Patel",
    email: null,
  },
  flags: {
    providerGuideDismissed: false,
  },
  billing: null,
  access: {
    kind: "limited",
    paid: false,
    reason: "free_signup_week",
    startDate: "2026-04-20",
    endDateExclusive: "2026-04-27",
  },
  stripeLinks: {
    customer: null,
    subscription: null,
  },
  accounts: [],
  providers: [],
  sessions: [],
};

function withAdminRoute(Story: ComponentType) {
  const rootRoute = createRootRoute({
    component: Outlet,
  });
  const adminUserRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin/users/$userId",
    component: () => <Story />,
  });
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/admin",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([adminRoute, adminUserRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ["/admin/users/00000000-0000-0000-0000-000000000101"],
    }),
  });

  return (
    <div className="min-h-screen w-screen bg-page">
      <RouterProvider router={router} />
    </div>
  );
}

const meta = {
  title: "Pages/AdminUserDetailPage",
  component: AdminUserDetailContent,
  tags: ["autodocs"],
  decorators: [withAdminRoute],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    detail: subscribedUserDetail,
    isAdminViewer: true,
    isLoading: false,
    onToggleAdmin: () => {},
    onTogglePaidGrant: () => {},
    onToggleProviderGuideDismissed: () => {},
  },
} satisfies Meta<typeof AdminUserDetailContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StripeSubscription: Story = {};

export const LocalFreeAccessGrant: Story = {
  args: {
    detail: localGrantUserDetail,
  },
};

export const LimitedNoBilling: Story = {
  args: {
    detail: limitedUserDetail,
  },
};

export const Loading: Story = {
  args: {
    detail: undefined,
    isLoading: true,
  },
};

export const ErrorState: Story = {
  args: {
    detail: undefined,
    errorMessage: "User not found.",
  },
};

export const NonAdminViewer: Story = {
  args: {
    detail: undefined,
    isAdminViewer: false,
  },
};
