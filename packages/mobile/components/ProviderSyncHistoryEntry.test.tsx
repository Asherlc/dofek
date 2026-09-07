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
});
