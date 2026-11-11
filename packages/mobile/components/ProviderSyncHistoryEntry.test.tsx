import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderSyncHistoryEntry } from "./ProviderSyncHistoryEntry";

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

    expect(screen.getAllByText("An activity file could not be read.")).toHaveLength(1);
    expect(
      screen.queryByText("Earlier updates remain available. Open Diagnostics for details."),
    ).toBeNull();
    expect(
      screen.queryByText("Some update data may be missing. Open Diagnostics for details."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));
    expect(screen.getAllByText("An activity file could not be read.")).toHaveLength(2);
    expect(screen.getByText("raw-log-123")).toBeTruthy();
  });

  it("keeps stale reconnect errors in diagnostics for an authorization failure", () => {
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

    expect(screen.getByText("Reconnect Garmin to resume incoming updates.")).toBeTruthy();
    expect(screen.queryByText("Try syncing Garmin again in the old client.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));
    expect(screen.getByText("Try syncing Garmin again in the old client.")).toBeTruthy();
  });

  it("shows a single outcome-specific fallback for a technical push failure", () => {
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
      screen.getAllByText("Earlier updates remain available. Open Diagnostics for details."),
    ).toHaveLength(1);
    expect(screen.queryByText("The update could not be processed.")).toBeNull();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it("keeps polling recovery guidance visible while storing its cause in diagnostics", () => {
    render(
      <ProviderSyncHistoryEntry
        providerName="Oura"
        entry={{
          ...expiredAuthorizationEntry,
          dataType: "sleep",
          authFailureReason: null,
          errorMessage: "The provider is unavailable.",
        }}
      />,
    );

    expect(
      screen.getByText("Try syncing Oura again. Open Diagnostics if the problem continues."),
    ).toBeTruthy();
    expect(screen.queryByText("The provider is unavailable.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));
    expect(screen.getByText("The provider is unavailable.")).toBeTruthy();
  });

  it("leads with the reconnect action and reveals raw failure details on request", () => {
    render(<ProviderSyncHistoryEntry providerName="WHOOP" entry={expiredAuthorizationEntry} />);

    expect(screen.getByText("Authorization expired")).toBeTruthy();
    expect(screen.getByText("Reconnect WHOOP to resume Strength data.")).toBeTruthy();
    expect(screen.queryByText("refresh_token_revoked")).toBeNull();
    expect(screen.queryByText("raw-log-123")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));

    expect(screen.getByText("refresh_token_revoked")).toBeTruthy();
    expect(screen.getByText("raw-log-123")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide diagnostics" })).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));
    expect(screen.getByText("The sync failed. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
  });

  it("shows an automatic update failure with its actionable error before opening diagnostics", () => {
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

    expect(screen.getByText("Activities update not processed")).toBeTruthy();
    expect(screen.getByText("An activity file could not be read.")).toBeTruthy();
    expect(screen.queryByText(/Try syncing/)).toBeNull();
    expect(screen.queryByText("raw-log-123")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show diagnostics" }));
    expect(screen.getByText("raw-log-123")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
  });
});
