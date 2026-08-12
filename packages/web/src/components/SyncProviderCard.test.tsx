// @vitest-environment jsdom
import { operationalStatusColors } from "@dofek/scoring/colors";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncProviderCard } from "./SyncProviderCard.tsx";

type SyncProviderCardProps = ComponentProps<typeof SyncProviderCard>;

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string;
    params: { id: string };
    children: React.ReactNode;
  }) => (
    <a href={to.replace("$id", params.id)} {...props}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function renderProvider({
  onSync = vi.fn(),
  provider = {
    id: "strava",
    name: "Strava",
    lastSyncedAt: "2026-05-12T10:00:00.000Z",
    lastSuccessfulSyncAt: "2026-05-12T10:00:00.000Z",
    syncFreshness: {
      status: "current",
      label: "Sync current",
      description: "The last successful sync completed within the expected cadence.",
    },
    authorized: true,
    description: null,
  },
  state = { status: "idle" },
  needsAuth = false,
  needsReauth = false,
  recentLogs = [],
}: {
  onSync?: () => void;
  provider?: SyncProviderCardProps["provider"];
  state?: SyncProviderCardProps["state"];
  needsAuth?: boolean;
  needsReauth?: boolean;
  recentLogs?: SyncProviderCardProps["recentLogs"];
} = {}) {
  render(
    <SyncProviderCard
      provider={provider}
      state={state}
      needsAuth={needsAuth}
      needsReauth={needsReauth}
      stats={undefined}
      recentLogs={recentLogs}
      onSync={onSync}
    />,
  );
}

describe("SyncProviderCard", () => {
  it("uses an explicit Sync button instead of making the provider name clickable", () => {
    const onSync = vi.fn();
    renderProvider({ onSync });

    expect(screen.getByText("Strava").closest("button")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sync Strava from the last 7 days" }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("exposes one primary action and one details link", () => {
    const onSync = vi.fn();
    renderProvider({ onSync });

    const primaryAction = screen.getByRole("button", {
      name: "Sync Strava from the last 7 days",
    });
    const detailsLink = screen.getByRole("link", { name: "View Strava details" });

    expect(screen.getAllByRole("button")).toEqual([primaryAction]);
    expect(screen.getAllByRole("link")).toEqual([detailsLink]);
    expect(detailsLink.getAttribute("href")).toBe("/providers/strava");
  });

  it("hides sync actions while syncing", () => {
    renderProvider({ state: { status: "syncing", percentage: 40, message: "Syncing activities" } });

    expect(screen.queryByRole("button", { name: "Sync Strava from the last 7 days" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync all available Strava data" })).toBeNull();
    expect(screen.getByText("Syncing activities")).not.toBeNull();
  });

  it("shows Connect as the primary action when auth is missing", () => {
    const onSync = vi.fn();
    renderProvider({ onSync, needsAuth: true });

    fireEvent.click(screen.getByRole("button", { name: "Connect Strava" }));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Connect")).toHaveLength(1);
    expect(screen.getByText("Not connected")).toHaveStyle({
      color: operationalStatusColors.info.foreground,
    });
  });

  it("shows Reconnect as the primary action when reauth is needed", () => {
    const onSync = vi.fn();
    renderProvider({ onSync, needsAuth: true, needsReauth: true });

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Strava" }));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Reconnect")).toHaveLength(1);
    expect(screen.getByText("Authorization expired")).toHaveStyle({
      color: operationalStatusColors.warning.foreground,
    });
  });

  it("renders server freshness for an authorized provider that needs reauthorization", () => {
    renderProvider({
      provider: {
        id: "strava",
        name: "Strava",
        lastSyncedAt: "2026-08-12T12:00:00.000Z",
        lastSuccessfulSyncAt: "2026-08-11T12:00:00.000Z",
        syncFreshness: {
          status: "overdue",
          label: "Sync overdue",
          description: "The last successful sync is overdue.",
        },
        authorized: true,
        description: null,
      },
      needsReauth: true,
    });

    expect(screen.getByText("Authorization expired")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect Strava" })).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Sync overdue");
    expect(screen.getByRole("alert")).toHaveTextContent("The last successful sync is overdue.");
  });

  it("renders an unknown server freshness state for an empty sync history", () => {
    renderProvider({
      provider: {
        id: "strava",
        name: "Strava",
        lastSyncedAt: null,
        lastSuccessfulSyncAt: null,
        syncFreshness: {
          status: "unknown",
          label: "Sync status unknown",
          description: "No successful sync has been recorded yet.",
        },
        authorized: true,
        description: null,
      },
    });

    expect(screen.getByText("No sync history")).not.toBeNull();
    expect(screen.getByText("Sync status unknown")).not.toBeNull();
    expect(screen.getByText("No successful sync has been recorded yet.")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders overdue server freshness as an alert beside the manual Sync action", () => {
    renderProvider({
      provider: {
        id: "strava",
        name: "Strava",
        lastSyncedAt: "2026-08-12T12:00:00.000Z",
        lastSuccessfulSyncAt: "2026-08-11T12:00:00.000Z",
        syncFreshness: {
          status: "overdue",
          label: "Sync overdue",
          description: "The last successful sync is overdue.",
        },
        authorized: true,
        description: null,
      },
    });

    const overdueAlert = screen.getByRole("alert");
    const syncButton = screen.getByRole("button", {
      name: "Sync Strava from the last 7 days",
    });

    expect(overdueAlert).toHaveTextContent("Sync overdue");
    expect(overdueAlert).toHaveTextContent("The last successful sync is overdue.");
    expect(overdueAlert.parentElement).toContainElement(syncButton);
    expect(screen.getByText(/^Last successful sync:/)).not.toBeNull();
  });

  it("renders current server freshness without raising an alert", () => {
    renderProvider();

    expect(screen.getByText("Sync current")).not.toBeNull();
    expect(
      screen.getByText("The last successful sync completed within the expected cadence."),
    ).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("identifies recent sync outcomes without relying on color", () => {
    renderProvider({
      recentLogs: [
        {
          syncedAt: "2026-05-12T10:00:00.000Z",
          status: "success",
          recordCount: 12,
          durationMs: 100,
          errorMessage: null,
          authFailureReason: null,
        },
        {
          syncedAt: "2026-05-12T11:00:00.000Z",
          status: "failed",
          recordCount: 0,
          durationMs: 50,
          errorMessage: "Provider unavailable",
          authFailureReason: null,
        },
      ],
    });

    expect(screen.getByRole("status", { name: "Sync succeeded" }).textContent).toBe("✓");
    expect(screen.getByRole("status", { name: "Sync failed" }).textContent).toBe("!");
  });

  it("uses neutral push-only copy and server-provided description", () => {
    render(
      <SyncProviderCard
        provider={{
          id: "whoop_ble",
          name: "WHOOP (Bluetooth)",
          lastSyncedAt: "2026-06-20T12:00:00.000Z",
          lastSuccessfulSyncAt: null,
          syncFreshness: null,
          authorized: true,
          description: "Synced from the iOS app when your WHOOP strap is nearby.",
        }}
        state={{ status: "idle" }}
        needsAuth={false}
        needsReauth={false}
        pushOnly
        stats={undefined}
        recentLogs={[]}
        onSync={vi.fn()}
      />,
    );

    const mobileSyncLabel = screen.getByText("Mobile sync");
    expect(mobileSyncLabel).not.toBeNull();
    expect(mobileSyncLabel.parentElement?.querySelector("img + span")).toHaveStyle({
      backgroundColor: operationalStatusColors.success.indicator,
    });
    expect(screen.getByText("Synced via iOS app")).not.toBeNull();
    expect(
      screen.getByText("Synced from the iOS app when your WHOOP strap is nearby."),
    ).not.toBeNull();
    expect(screen.queryByText("Receiving data")).toBeNull();
    expect(screen.queryByText("Live BLE push")).toBeNull();
  });
});
