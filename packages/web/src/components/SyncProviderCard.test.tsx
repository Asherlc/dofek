// @vitest-environment jsdom
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
  onFullSync = vi.fn(),
  provider = {
    id: "strava",
    name: "Strava",
    lastSyncedAt: "2026-05-12T10:00:00.000Z",
    authorized: true,
  },
  state = { status: "idle" },
  needsAuth = false,
  needsReauth = false,
  recentLogs = [],
}: {
  onSync?: () => void;
  onFullSync?: () => void;
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
      onFullSync={onFullSync}
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

  it("keeps Full sync as a separate action", () => {
    const onSync = vi.fn();
    const onFullSync = vi.fn();
    renderProvider({ onSync, onFullSync });

    fireEvent.click(screen.getByRole("button", { name: "Sync all available Strava data" }));

    expect(onFullSync).toHaveBeenCalledTimes(1);
    expect(onSync).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("button", { name: "Sync all available Strava data" })).toBeNull();
  });

  it("shows Reconnect as the primary action when reauth is needed", () => {
    const onSync = vi.fn();
    renderProvider({ onSync, needsAuth: true, needsReauth: true });

    fireEvent.click(screen.getByRole("button", { name: "Reconnect Strava" }));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Sync all available Strava data" })).toBeNull();
  });

  it("renders an empty sync history state", () => {
    renderProvider();

    expect(screen.getByText("No sync history")).not.toBeNull();
  });
});
