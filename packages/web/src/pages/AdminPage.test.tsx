// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage.tsx";

const mockUseAuth = vi.hoisted(() => vi.fn());
const mockSetAdminMutate = vi.hoisted(() => vi.fn());
const mockDeleteSessionMutate = vi.hoisted(() => vi.fn());
const mockUsersInvalidate = vi.hoisted(() => vi.fn());
const mockSessionsInvalidate = vi.hoisted(() => vi.fn());
const mockOverviewUseQuery = vi.hoisted(() => vi.fn());
const mockUsersUseQuery = vi.hoisted(() => vi.fn());
const mockSyncHealthUseQuery = vi.hoisted(() => vi.fn());
const mockRateLimitsUseQuery = vi.hoisted(() => vi.fn());
const mockSyncLogsUseQuery = vi.hoisted(() => vi.fn());
const mockActivitiesUseQuery = vi.hoisted(() => vi.fn());
const mockSleepSessionsUseQuery = vi.hoisted(() => vi.fn());
const mockFoodEntriesUseQuery = vi.hoisted(() => vi.fn());
const mockBodyMeasurementsUseQuery = vi.hoisted(() => vi.fn());
const mockDailyMetricsUseQuery = vi.hoisted(() => vi.fn());
const mockSessionsUseQuery = vi.hoisted(() => vi.fn());
const mockOauthTokensUseQuery = vi.hoisted(() => vi.fn());

function queryResult<T>(data: T) {
  return { data, error: null, isLoading: false };
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to,
  }: {
    children: ReactNode;
    params?: { userId?: string };
    to: string;
  }) => <a href={params?.userId ? `/admin/users/${params.userId}` : to}>{children}</a>,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("../components/DeveloperClientsAdminPanel.tsx", () => ({
  DeveloperClientsAdminPanel: () => <div>Developer client panel</div>,
}));

vi.mock("../lib/auth-context.tsx", () => ({ useAuth: mockUseAuth }));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    admin: {
      overview: { useQuery: mockOverviewUseQuery },
      users: { useQuery: mockUsersUseQuery },
      setAdmin: { useMutation: () => ({ mutate: mockSetAdminMutate, isPending: false }) },
      syncHealth: { useQuery: mockSyncHealthUseQuery },
      rateLimits: { useQuery: mockRateLimitsUseQuery },
      syncLogs: { useQuery: mockSyncLogsUseQuery },
      activities: { useQuery: mockActivitiesUseQuery },
      sleepSessions: { useQuery: mockSleepSessionsUseQuery },
      foodEntries: { useQuery: mockFoodEntriesUseQuery },
      bodyMeasurements: { useQuery: mockBodyMeasurementsUseQuery },
      dailyMetrics: { useQuery: mockDailyMetricsUseQuery },
      sessions: { useQuery: mockSessionsUseQuery },
      deleteSession: { useMutation: () => ({ mutate: mockDeleteSessionMutate, isPending: false }) },
      oauthTokens: { useQuery: mockOauthTokensUseQuery },
    },
    useUtils: () => ({
      admin: {
        users: { invalidate: mockUsersInvalidate },
        sessions: { invalidate: mockSessionsInvalidate },
      },
    }),
  },
}));

function configureSuccessfulQueries() {
  mockOverviewUseQuery.mockReturnValue(queryResult([{ table_name: "activity", row_count: 1234 }]));
  mockUsersUseQuery.mockReturnValue(
    queryResult([
      {
        id: "user-123456789",
        name: "Ada Admin",
        email: "ada@example.com",
        is_admin: false,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]),
  );
  mockSyncHealthUseQuery.mockReturnValue(
    queryResult([
      {
        provider_id: "whoop",
        total: 10,
        succeeded: 8,
        failed: 2,
        last_sync: "2026-01-01T00:00:00Z",
      },
    ]),
  );
  mockRateLimitsUseQuery.mockReturnValue(
    queryResult([
      {
        providerId: "strava",
        scope: "user",
        userId: "user-123456789",
        queueLimiterMax: 5,
        queueLimiterDurationMs: 90_000,
        syncTier: "active",
        throttleMs: 500,
        defaultThrottleMs: 1_000,
        inferredBudget: 120,
        requestCount: 8,
        observedCooldownSeconds: 30,
        cooldownExpiresAt: "2026-12-01T00:00:00Z",
        consecutiveHits: 2,
        stravaShortUsage: 20,
        stravaShortLimit: 100,
        stravaDailyUsage: 200,
        stravaDailyLimit: 1000,
      },
    ]),
  );
  mockSyncLogsUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          provider_id: "whoop",
          user_name: "Ada Admin",
          data_type: "activity",
          status: "error",
          record_count: 0,
          error_message: "Provider unavailable",
          synced_at: "2026-01-01T00:00:00Z",
        },
      ],
      total: 51,
    }),
  );
  mockActivitiesUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          id: "activity-123456789",
          user_name: "Ada Admin",
          provider_id: "whoop",
          canonical_type: "running",
          name: "Morning run",
          duration_seconds: 3661,
          started_at: "2026-01-01T00:00:00Z",
          source_name: "Watch",
        },
      ],
      total: 51,
    }),
  );
  mockSleepSessionsUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          id: "sleep-123456789",
          user_name: "Ada Admin",
          provider_id: "whoop",
          sleep_type: "night",
          started_at: "2026-01-01T00:00:00Z",
          ended_at: "2026-01-01T08:00:00Z",
          source_name: "Watch",
        },
      ],
      total: 51,
    }),
  );
  mockFoodEntriesUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          id: "food-123456789",
          user_name: "Ada Admin",
          food_name: "Oatmeal",
          calories: 120.4,
          protein_g: 8.5,
          meal: "breakfast",
          logged_at: "2026-01-01T00:00:00Z",
          provider_id: "manual",
        },
      ],
      total: 51,
    }),
  );
  mockBodyMeasurementsUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          id: "body-123456789",
          user_name: "Ada Admin",
          provider_id: "whoop",
          recorded_at: "2026-01-01T00:00:00Z",
          source_name: "Scale",
        },
      ],
      total: 51,
    }),
  );
  mockDailyMetricsUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          id: "metric-123456789",
          user_name: "Ada Admin",
          date: "2026-01-01",
          provider_id: "whoop",
          source_name: "Watch",
        },
      ],
      total: 51,
    }),
  );
  mockSessionsUseQuery.mockReturnValue(
    queryResult({
      rows: [
        {
          id: "session-123456789",
          user_name: "Ada Admin",
          created_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-12-01T00:00:00Z",
          is_expired: false,
        },
      ],
      total: 51,
    }),
  );
  mockOauthTokensUseQuery.mockReturnValue(
    queryResult([
      {
        user_name: "Ada Admin",
        provider_id: "strava",
        scopes: "read,activity:read",
        expires_at: "2026-12-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]),
  );
}

beforeEach(() => {
  configureSuccessfulQueries();
  mockUseAuth.mockReturnValue({ user: { isAdmin: true } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminPage", () => {
  it("blocks non-admin users before loading admin data", () => {
    mockUseAuth.mockReturnValue({ user: { isAdmin: false } });

    render(<AdminPage />);

    expect(screen.getByText("You do not have admin access.")).toBeTruthy();
    expect(mockOverviewUseQuery).not.toHaveBeenCalled();
  });

  it("renders each administrative data view and performs its available actions", () => {
    render(<AdminPage />);

    expect(screen.getByText("1,234")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(screen.getByRole("link", { name: "Ada Admin" }).getAttribute("href")).toBe(
      "/admin/users/user-123456789",
    );
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(mockSetAdminMutate).toHaveBeenCalledWith({ userId: "user-123456789", isAdmin: true });

    for (const label of [
      "Sync Health",
      "Rate Limits",
      "Sync Logs",
      "Activities",
      "Sleep",
      "Food",
      "Body",
      "Daily Metrics",
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }

    expect(screen.getAllByText("Daily Metrics")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByText("Active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(mockDeleteSessionMutate).toHaveBeenCalledWith({ sessionId: "session-123456789" });

    fireEvent.click(screen.getByRole("button", { name: "OAuth Tokens" }));
    expect(screen.getByText("read,activity:read")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Developer Clients" }));
    expect(screen.getByText("Developer client panel")).toBeTruthy();
  });

  it("shows the query error returned by an administrative view", () => {
    mockSyncHealthUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Sync health is unavailable."),
      isLoading: false,
    });

    render(<AdminPage />);
    fireEvent.click(screen.getByRole("button", { name: "Sync Health" }));

    expect(screen.getByText("Sync health is unavailable.")).toBeTruthy();
  });
});
