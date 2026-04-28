// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage.tsx";
import { AdminUserDetailPage } from "./AdminUserDetailPage.tsx";

const mockUseAuth = vi.hoisted(() => vi.fn());
const mockUseParams = vi.hoisted(() => vi.fn(() => ({ userId: "user-1" })));
const mockSetAdminMutate = vi.hoisted(() => vi.fn());
const mockSetProviderGuideDismissedMutate = vi.hoisted(() => vi.fn());
const mockSetPaidGrantMutate = vi.hoisted(() => vi.fn());
const mockUsersInvalidate = vi.hoisted(() => vi.fn());
const mockUserDetailInvalidate = vi.hoisted(() => vi.fn());

const mockAdminUsersQuery = vi.hoisted(() =>
  vi.fn(() => ({
    data: [
      {
        id: "user-1",
        name: "Alice Admin",
        email: "alice@example.com",
        birth_date: null,
        is_admin: true,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      },
    ],
    isLoading: false,
    error: null,
  })),
);

const mockAdminUserDetailQuery = vi.hoisted(() =>
  vi.fn(() => ({
    data: {
      profile: {
        id: "user-1",
        name: "Alice Admin",
        email: "alice@example.com",
        birth_date: null,
        is_admin: false,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      },
      flags: { providerGuideDismissed: false },
      billing: {
        user_id: "user-1",
        stripe_customer_id: "cus_123",
        stripe_subscription_id: "sub_123",
        stripe_subscription_status: "active",
        stripe_current_period_end: "2026-05-01T00:00:00Z",
        paid_grant_reason: null,
        created_at: "2024-01-03T00:00:00Z",
        updated_at: "2024-01-04T00:00:00Z",
      },
      access: { kind: "full", paid: true, reason: "stripe_subscription" },
      stripeLinks: {
        customer: "https://dashboard.stripe.com/customers/cus_123",
        subscription: "https://dashboard.stripe.com/subscriptions/sub_123",
      },
      accounts: [
        {
          id: "account-1",
          auth_provider: "google",
          provider_account_id: "google-1",
          email: "alice@example.com",
          name: "Alice Admin",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      providers: [{ id: "whoop", name: "WHOOP", created_at: "2024-01-05T00:00:00Z" }],
      sessions: [
        {
          id: "session-1",
          created_at: "2024-01-06T00:00:00Z",
          expires_at: "2024-02-06T00:00:00Z",
        },
      ],
    },
    isLoading: false,
    error: null,
  })),
);

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    activeProps: _activeProps,
    activeOptions: _activeOptions,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
    activeProps?: unknown;
    activeOptions?: unknown;
  }) => {
    const href =
      to === "/admin/users/$userId" &&
      typeof params === "object" &&
      params !== null &&
      "userId" in params &&
      typeof params.userId === "string"
        ? `/admin/users/${params.userId}`
        : to;
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
  useParams: (...args: unknown[]) => mockUseParams(...args),
}));

vi.mock("../lib/auth-context.tsx", () => ({
  useAuth: mockUseAuth,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    admin: {
      overview: { useQuery: () => ({ data: [], isLoading: false, error: null }) },
      refreshViews: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      users: { useQuery: mockAdminUsersQuery },
      userDetail: { useQuery: mockAdminUserDetailQuery },
      setAdmin: { useMutation: () => ({ mutate: mockSetAdminMutate, isPending: false }) },
      setProviderGuideDismissed: {
        useMutation: () => ({ mutate: mockSetProviderGuideDismissedMutate, isPending: false }),
      },
      setPaidGrant: { useMutation: () => ({ mutate: mockSetPaidGrantMutate, isPending: false }) },
    },
    useUtils: () => ({
      admin: {
        users: { invalidate: mockUsersInvalidate },
        userDetail: { invalidate: mockUserDetailInvalidate },
      },
    }),
  },
}));

beforeEach(() => {
  mockUseAuth.mockReturnValue({
    user: { id: "admin-1", name: "Root", email: "root@example.com", isAdmin: true },
    isLoading: false,
    logout: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminPage user links", () => {
  it("links users to their admin detail page", () => {
    render(<AdminPage />);
    fireEvent.click(screen.getByRole("button", { name: "Users" }));

    const link = screen.getByRole("link", { name: "Alice Admin" });
    expect(link.getAttribute("href")).toBe("/admin/users/user-1");
  });
});

describe("AdminUserDetailPage", () => {
  it("renders profile, local flags, billing state, and Stripe links", () => {
    render(<AdminUserDetailPage />);

    expect(screen.getAllByText("Alice Admin").length).toBeGreaterThan(0);
    expect(screen.getAllByText("alice@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("Provider guide banner")).toBeTruthy();
    expect(screen.getByText("Stripe subscription status: active")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Customer in Stripe" }).getAttribute("href")).toBe(
      "https://dashboard.stripe.com/customers/cus_123",
    );
    expect(
      screen.getByRole("link", { name: "Open Subscription in Stripe" }).getAttribute("href"),
    ).toBe("https://dashboard.stripe.com/subscriptions/sub_123");
  });

  it("calls local admin mutations from detail controls", () => {
    render(<AdminUserDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Make admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark banner dismissed" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant free access" }));

    expect(mockSetAdminMutate).toHaveBeenCalledWith({ userId: "user-1", isAdmin: true });
    expect(mockSetProviderGuideDismissedMutate).toHaveBeenCalledWith({
      userId: "user-1",
      dismissed: true,
    });
    expect(mockSetPaidGrantMutate).toHaveBeenCalledWith({ userId: "user-1", enabled: true });
  });

  it("blocks non-admin users", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "user-2", name: "Member", email: null, isAdmin: false },
      isLoading: false,
      logout: vi.fn(),
    });

    render(<AdminUserDetailPage />);

    expect(screen.getByText("You do not have admin access.")).toBeTruthy();
    expect(mockAdminUserDetailQuery).not.toHaveBeenCalled();
  });
});
