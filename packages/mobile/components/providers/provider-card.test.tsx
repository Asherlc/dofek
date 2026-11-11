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

describe("OAuth notification providers", () => {
  it.each(["not_connected", "expired"] as const)(
    "keeps Garmin authorization available when %s",
    (authStatus) => {
      const { onConnect, onSync } = renderProvider({
        id: "garmin",
        label: "Garmin",
        pushOnly: true,
        authStatus,
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: authStatus === "not_connected" ? "Connect Garmin" : "Reconnect Garmin",
        }),
      );
      expect(onConnect).toHaveBeenCalledOnce();
      expect(onSync).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Sync Garmin" })).toBeNull();
    },
  );

  it("shows a connected automatic source waiting for its first processed update", () => {
    renderProvider({
      id: "garmin",
      label: "Garmin",
      pushOnly: true,
      lastProcessedUpdateAt: null,
      recentLogs: [],
    });

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Updates automatically")).toBeTruthy();
    expect(screen.getByText("Waiting for first update")).toBeTruthy();
    expect(screen.queryByText(/^Last update processed:/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect Garmin" })).toBeNull();
  });

  it("keeps a processing failure separate from its connection and last completed update", () => {
    renderProvider({
      id: "garmin",
      label: "Garmin",
      pushOnly: true,
      lastProcessedUpdateAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      recentLogs: [
        {
          ...successfulLog,
          providerId: "garmin",
          status: "error",
          syncedAt: new Date().toISOString(),
          errorMessage: "An activity file could not be read.",
        },
      ],
    });

    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Updates automatically")).toBeTruthy();
    expect(screen.getByText("Last update processed: 25m ago")).toBeTruthy();
    expect(screen.getByText("Couldn't process the latest update")).toBeTruthy();
    expect(screen.queryByText("Waiting for first update")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect Garmin" })).toBeNull();
  });
});

it("keeps mobile capture actions in source details", () => {
  renderProvider({
    id: "whoop_ble",
    label: "WHOOP (Bluetooth)",
    authType: "push:mobile",
    pushOnly: true,
  });
  expect(screen.getByRole("button", { name: "Open WHOOP (Bluetooth) details" })).toBeTruthy();
  expect(screen.getByText("Push only")).toBeTruthy();
  expect(screen.queryByText("Updates automatically")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect WHOOP (Bluetooth)" })).toBeNull();
});
