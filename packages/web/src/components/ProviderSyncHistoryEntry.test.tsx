/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderSyncHistoryEntry } from "./ProviderSyncHistoryEntry.tsx";

const expiredAuthorizationEntry = {
  id: "raw-log-123",
  syncedAt: "2026-07-24T12:00:00.000Z",
  dataType: "strength",
  status: "error" as const,
  recordCount: null,
  durationMs: 1250,
  errorMessage: "OAuth token refresh returned invalid_grant",
  authFailureReason: "refresh_token_revoked",
};

describe("ProviderSyncHistoryEntry", () => {
  it.each(["error", "degraded"])("renders one actionable message for a push %s", (status) => {
    render(
      <ProviderSyncHistoryEntry
        providerName="Garmin"
        pushOnly
        entry={{
          ...expiredAuthorizationEntry,
          dataType: "update",
          status,
          authFailureReason: null,
          errorMessage: "An activity file could not be read.",
        }}
      />,
    );

    const causeNodes = screen.getAllByText("An activity file could not be read.");
    expect(causeNodes.filter((node) => !node.closest("details"))).toHaveLength(1);
    expect(causeNodes.find((node) => !node.closest("details"))).toBeVisible();
    expect(
      screen.queryByText("Earlier updates remain available. Open Diagnostics for details."),
    ).toBeNull();
    expect(
      screen.queryByText("Some update data may be missing. Open Diagnostics for details."),
    ).toBeNull();
    fireEvent.click(screen.getByText("Diagnostics"));
    expect(screen.getByText("raw-log-123")).toBeVisible();
    expect(causeNodes.find((node) => node.closest("details"))).toBeVisible();
  });

  it("keeps stale reconnect errors inside diagnostics for authorization failures", () => {
    render(
      <ProviderSyncHistoryEntry
        providerName="Garmin"
        pushOnly
        entry={{
          ...expiredAuthorizationEntry,
          dataType: "update",
          authFailureReason: "authorization_failed",
          errorMessage: "Try syncing Garmin again in the old client.",
        }}
      />,
    );

    expect(screen.getByText("Reconnect Garmin to resume incoming updates.")).toBeVisible();
    expect(screen.getByText("Try syncing Garmin again in the old client.")).not.toBeVisible();
    fireEvent.click(screen.getByText("Diagnostics"));
    expect(screen.getByText("Try syncing Garmin again in the old client.")).toBeVisible();
  });

  it("uses outcome guidance instead of runtime details for a technical push failure", () => {
    render(
      <ProviderSyncHistoryEntry
        providerName="Garmin"
        pushOnly
        entry={{
          ...expiredAuthorizationEntry,
          dataType: "update",
          authFailureReason: null,
          errorMessage: "TypeError: Cannot read properties of undefined",
        }}
      />,
    );

    expect(
      screen.getByText("Earlier updates remain available. Open Diagnostics for details."),
    ).toBeVisible();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it("shows a push processing failure and its actionable cause before diagnostics", () => {
    render(
      <ProviderSyncHistoryEntry
        providerName="Garmin"
        pushOnly
        entry={{
          ...expiredAuthorizationEntry,
          dataType: "activities",
          authFailureReason: null,
          errorMessage: "An activity file could not be read.",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Activities update not processed" })).toBeVisible();
    expect(screen.getAllByText("An activity file could not be read.")[0]).toBeVisible();
    expect(screen.getByText("Diagnostics").closest("details")).not.toHaveAttribute("open");
  });

  it("leads with the reconnect action and keeps raw failure details closed", () => {
    render(<ProviderSyncHistoryEntry providerName="WHOOP" entry={expiredAuthorizationEntry} />);

    expect(screen.getByRole("heading", { name: "Authorization expired" })).toBeTruthy();
    expect(screen.getByText("Reconnect WHOOP to resume Strength data.")).toBeTruthy();

    const diagnostics = screen.getByText("Diagnostics").closest("details");
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("refresh_token_revoked")).toBeTruthy();
    expect(screen.getByText("raw-log-123")).toBeTruthy();
  });

  it("does not show raw runtime details in error diagnostics", () => {
    render(
      <ProviderSyncHistoryEntry
        providerName="WHOOP"
        entry={{
          ...expiredAuthorizationEntry,
          authFailureReason: null,
          errorMessage: "TypeError: Cannot read properties of undefined (reading 'token')",
        }}
      />,
    );

    expect(screen.getByText("The sync failed. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });
});
