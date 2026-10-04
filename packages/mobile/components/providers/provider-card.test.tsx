// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Provider, ProviderCard, type SyncLog } from "./provider-card";

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ serverUrl: "https://example.com" }),
}));

const successfulLog: SyncLog = {
  id: "last-success",
  providerId: "strava",
  syncedAt: "2026-05-12T10:00:00.000Z",
  status: "success",
  dataType: "activities",
  recordCount: 12,
  durationMs: 100,
  errorMessage: null,
  authFailureReason: null,
};
const provider: Provider = {
  id: "strava",
  label: "Strava",
  enabled: true,
  authStatus: "connected",
  authType: "oauth",
  lastSyncAt: "2026-05-12T10:00:00.000Z",
  lastSuccessfulSyncAt: "2026-05-12T10:00:00.000Z",
  syncFreshness: { status: "current", label: "Sync current" },
  importOnly: false,
  pushOnly: false,
  recentLogs: [successfulLog],
};

function renderProvider(overrides: Partial<Provider> = {}) {
  const onSync = vi.fn();
  const onConnect = vi.fn();
  render(
    <ProviderCard
      provider={{ ...provider, ...overrides }}
      stats={undefined}
      syncing={false}
      syncProgress={undefined}
      onSync={onSync}
      onConnect={onConnect}
      onPress={vi.fn()}
    />,
  );
  return { onSync, onConnect };
}

describe("ProviderCard sync summary", () => {
  it("summarizes a successful current sync once and keeps its action", () => {
    const { onSync } = renderProvider();
    expect(screen.getAllByText("Sync current")).toHaveLength(1);
    expect(screen.getAllByText(/^Last (?:sync|attempt|successful sync):/)).toHaveLength(1);
    expect(screen.getByText(/^Last successful sync:/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sync Strava" }));
    expect(onSync).toHaveBeenCalledOnce();
  });

  it("uses freshness rather than a historical success to describe overdue data", () => {
    renderProvider({
      syncFreshness: {
        status: "overdue",
        label: "Sync overdue",
        description: "The last successful sync is overdue.",
      },
    });
    expect(screen.getByText("Sync overdue")).toBeTruthy();
    expect(screen.getByText("The last successful sync is overdue.")).toBeTruthy();
    expect(screen.queryByText("Sync current")).toBeNull();
  });

  it("keeps a failed attempt, its successful-update time, and reconnect action visible", () => {
    const { onConnect } = renderProvider({
      authStatus: "expired",
      lastSyncAt: "2026-05-13T10:00:00.000Z",
      recentLogs: [
        {
          ...successfulLog,
          id: "failed-attempt",
          status: "error",
          syncedAt: "2026-05-13T10:00:00.000Z",
          errorMessage: "Authorization expired",
          authFailureReason: "access_token_expired",
        },
      ],
    });
    expect(screen.getByText(/^Last attempt:/)).toBeTruthy();
    expect(screen.getByText(/^Last successful sync:/)).toBeTruthy();
    expect(screen.getByText("Latest sync failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Strava" }));
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
