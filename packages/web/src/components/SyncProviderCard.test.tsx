// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncProviderCard } from "./SyncProviderCard.tsx";

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

function renderConnectedProvider({
  onSync = vi.fn(),
  onFullSync = vi.fn(),
}: {
  onSync?: () => void;
  onFullSync?: () => void;
} = {}) {
  render(
    <SyncProviderCard
      provider={{
        id: "strava",
        name: "Strava",
        lastSyncedAt: "2026-05-12T10:00:00.000Z",
        authorized: true,
      }}
      state={{ status: "idle" }}
      needsAuth={false}
      needsReauth={false}
      stats={undefined}
      recentLogs={[]}
      onSync={onSync}
      onFullSync={onFullSync}
    />,
  );
}

describe("SyncProviderCard", () => {
  it("uses an explicit Sync button instead of making the provider name clickable", () => {
    const onSync = vi.fn();
    renderConnectedProvider({ onSync });

    expect(screen.getByText("Strava").closest("button")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sync" }));

    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it("keeps Full sync as a separate action", () => {
    const onSync = vi.fn();
    const onFullSync = vi.fn();
    renderConnectedProvider({ onSync, onFullSync });

    fireEvent.click(screen.getByRole("button", { name: "Full sync" }));

    expect(onFullSync).toHaveBeenCalledTimes(1);
    expect(onSync).not.toHaveBeenCalled();
  });
});
