import { describe, expect, it } from "vitest";
import { ROUTINE_SYNC_DAYS, SYNC_ALL_ACTIONS } from "./sync-actions.ts";

describe("SYNC_ALL_ACTIONS", () => {
  it("defines the routine action as a recent seven-day sync", () => {
    expect(ROUTINE_SYNC_DAYS).toBe(7);
    expect(SYNC_ALL_ACTIONS.recent.label).toMatch(/recent/i);
    expect(SYNC_ALL_ACTIONS.recent.description).toMatch(
      new RegExp(`last ${ROUTINE_SYNC_DAYS} days`, "i"),
    );
    expect(SYNC_ALL_ACTIONS.recent.accessibilityLabel).toMatch(/all providers/i);
    expect(SYNC_ALL_ACTIONS.recent.accessibilityLabel).toMatch(
      new RegExp(`last ${ROUTINE_SYNC_DAYS} days`, "i"),
    );
  });

  it("explains the material full-history impact in layman-readable language", () => {
    const explanation = SYNC_ALL_ACTIONS.full.confirmationDescription;

    expect(explanation).toMatch(/all history.*provider.*available/i);
    expect(explanation).toMatch(/longer/i);
    expect(explanation).toMatch(/more provider requests/i);
    expect(explanation).toMatch(/matching records are updated/i);
    expect(explanation).toMatch(/activities removed.*may be hidden/i);
    expect(explanation).toMatch(/does not erase or rebuild unrelated Dofek data/i);
  });

  it("uses explicit confirmation and progress wording", () => {
    expect(SYNC_ALL_ACTIONS.full.label).toMatch(/full history/i);
    expect(SYNC_ALL_ACTIONS.full.confirmLabel).toBe("Start full sync");
    expect(SYNC_ALL_ACTIONS.full.cancelLabel).toBe("Cancel");
    expect(SYNC_ALL_ACTIONS.progressMessage).toMatch(/follow each provider below/i);
  });
});
