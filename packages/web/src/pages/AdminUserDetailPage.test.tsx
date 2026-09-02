// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage.tsx";
import { type AdminUserDetail, AdminUserDetailPage } from "./AdminUserDetailPage.tsx";

type AdminUserDetailQueryResult = {
  data: AdminUserDetail | undefined;
  isLoading: boolean;
  error: Error | null;
};

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
  vi.fn(
    (): AdminUserDetailQueryResult => ({
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
          app_store_product_id: null,
          app_store_subscription_status: null,
          app_store_expires_at: null,
          app_store_revocation_at: null,
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
    }),
  ),
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
  useParams: () => mockUseParams(),
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

  it("shows loading, server-error, and absent-user states before rendering details", () => {
    mockAdminUserDetailQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { rerender } = render(<AdminUserDetailPage />);

    expect(document.querySelector(".animate-spin")).toBeTruthy();

    mockAdminUserDetailQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("User detail lookup is unavailable"),
    });
    rerender(<AdminUserDetailPage />);
    expect(screen.getByText("User detail lookup is unavailable")).toBeTruthy();

    mockAdminUserDetailQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    rerender(<AdminUserDetailPage />);
    expect(screen.getByText("User not found.")).toBeTruthy();
  });

  it("renders limited access and empty related records without inventing billing data", () => {
    mockAdminUserDetailQuery.mockReturnValue({
      data: {
        profile: {
          id: "user-limited",
          name: "Limited Member",
          email: null,
          birth_date: null,
          is_admin: true,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        flags: { providerGuideDismissed: true },
        billing: null,
        access: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-01-01",
          endDateExclusive: "2026-01-08",
        },
        stripeLinks: { customer: null, subscription: null },
        accounts: [],
        providers: [],
        sessions: [],
      },
      isLoading: false,
      error: null,
    });

    render(<AdminUserDetailPage />);

    expect(screen.getByText("Limited to 2026-01-01 through 2026-01-08")).toBeTruthy();
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(10);
    expect(screen.getAllByText("No accounts")).toHaveLength(1);
    expect(screen.getAllByText("No providers")).toHaveLength(1);
    expect(screen.getAllByText("No sessions")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Open .* in Stripe/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark banner visible" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant free access" }));

    expect(mockSetAdminMutate).toHaveBeenCalledWith({ userId: "user-limited", isAdmin: false });
    expect(mockSetProviderGuideDismissedMutate).toHaveBeenCalledWith({
      userId: "user-limited",
      dismissed: false,
    });
    expect(mockSetPaidGrantMutate).toHaveBeenCalledWith({ userId: "user-limited", enabled: true });
  });

  it("renders local paid access and account identifiers when an auth email is absent", () => {
    mockAdminUserDetailQuery.mockReturnValue({
      data: {
        profile: {
          id: "user-paid",
          name: "Paid Member",
          email: "paid@example.com",
          birth_date: "1990-01-01",
          is_admin: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        flags: { providerGuideDismissed: false },
        billing: {
          user_id: "user-paid",
          stripe_customer_id: null,
          stripe_subscription_id: null,
          stripe_subscription_status: null,
          stripe_current_period_end: null,
          app_store_product_id: null,
          app_store_subscription_status: null,
          app_store_expires_at: null,
          app_store_revocation_at: null,
          paid_grant_reason: "migration",
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-04T00:00:00Z",
        },
        access: { kind: "full", paid: true, reason: "paid_grant" },
        stripeLinks: { customer: null, subscription: null },
        accounts: [
          {
            id: "account-paid",
            auth_provider: "apple",
            provider_account_id: "apple-subject-123",
            email: null,
            name: null,
            created_at: "2026-01-03T00:00:00Z",
          },
        ],
        providers: [],
        sessions: [],
      },
      isLoading: false,
      error: null,
    });

    render(<AdminUserDetailPage />);

    expect(screen.getByText("Full access from local grant")).toBeTruthy();
    expect(screen.getByText("migration")).toBeTruthy();
    expect(screen.getByText("apple-subject-123")).toBeTruthy();
    expect(screen.queryByText(/Stripe subscription status:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke free access" }));
    expect(mockSetPaidGrantMutate).toHaveBeenCalledWith({ userId: "user-paid", enabled: false });
  });

  it("identifies App Store subscription access", () => {
    mockAdminUserDetailQuery.mockReturnValue({
      data: {
        profile: {
          id: "user-app-store",
          name: "App Store Subscriber",
          email: "subscriber@example.com",
          birth_date: null,
          is_admin: false,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        flags: { providerGuideDismissed: false },
        billing: {
          user_id: "user-app-store",
          stripe_customer_id: null,
          stripe_subscription_id: null,
          stripe_subscription_status: null,
          stripe_current_period_end: null,
          app_store_product_id: "com.dofek.premium.monthly",
          app_store_subscription_status: "active",
          app_store_expires_at: "2026-10-01T00:00:00Z",
          app_store_revocation_at: null,
          paid_grant_reason: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        access: { kind: "full", paid: true, reason: "app_store_subscription" },
        stripeLinks: { customer: null, subscription: null },
        accounts: [],
        providers: [],
        sessions: [],
      },
      isLoading: false,
      error: null,
    });

    render(<AdminUserDetailPage />);

    expect(screen.getByText("Full access from App Store subscription")).toBeTruthy();
    expect(screen.getByText("com.dofek.premium.monthly")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    const expectedExpiry = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date("2026-10-01T00:00:00Z"));
    expect(screen.getByText(expectedExpiry)).toBeTruthy();
  });
});
