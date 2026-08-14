/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
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
});
