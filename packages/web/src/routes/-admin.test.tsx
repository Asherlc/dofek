// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTree } from "../routeTree.gen.ts";

const mockUseAuth = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth-context.tsx", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: mockUseAuth,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    admin: {
      overview: { useQuery: () => ({ data: [], isLoading: false, error: null }) },
      refreshViews: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      users: { useQuery: () => ({ data: [], isLoading: false, error: null }) },
      userDetail: {
        useQuery: () => ({
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
            billing: null,
            access: {
              kind: "limited",
              paid: false,
              reason: "free_signup_week",
              startDate: "2024-01-01",
              endDateExclusive: "2024-01-08",
            },
            stripeLinks: { customer: null, subscription: null },
            accounts: [],
            providers: [],
            sessions: [],
          },
          isLoading: false,
          error: null,
        }),
      },
      setAdmin: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setProviderGuideDismissed: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setPaidGrant: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({
      admin: {
        users: { invalidate: vi.fn() },
        userDetail: { invalidate: vi.fn() },
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
  vi.clearAllMocks();
});

describe("admin routes", () => {
  it("renders the nested user detail route", async () => {
    const queryClient = new QueryClient();
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/admin/users/user-1"] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/users/user-1"));
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
  });
});
