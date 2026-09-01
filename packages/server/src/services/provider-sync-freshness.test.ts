import { describe, expect, it } from "vitest";
import { evaluateProviderSyncFreshness } from "./provider-sync-freshness.ts";

const now = new Date("2026-08-12T12:00:00.000Z");
const intervalMinutes = 30;

describe("evaluateProviderSyncFreshness", () => {
  it("reports an unknown status when no successful sync has been recorded", () => {
    expect(
      evaluateProviderSyncFreshness({
        now,
        lastSuccessfulSyncAt: null,
        intervalMinutes,
      }),
    ).toEqual({
      status: "unknown",
      label: "Sync status unknown",
      description: "No successful sync has been recorded.",
    });
  });

  it("reports a recent successful sync as current", () => {
    expect(
      evaluateProviderSyncFreshness({
        now,
        lastSuccessfulSyncAt: new Date("2026-08-12T11:15:00.000Z"),
        intervalMinutes,
      }),
    ).toEqual({
      status: "current",
      label: "Sync current",
    });
  });

  it("keeps a successful sync at the cadence-plus-grace boundary current", () => {
    expect(
      evaluateProviderSyncFreshness({
        now,
        lastSuccessfulSyncAt: new Date("2026-08-12T11:00:00.000Z"),
        intervalMinutes,
      }),
    ).toEqual({
      status: "current",
      label: "Sync current",
    });
  });

  it("reports a successful sync beyond the cadence-plus-grace boundary as overdue", () => {
    expect(
      evaluateProviderSyncFreshness({
        now,
        lastSuccessfulSyncAt: new Date("2026-08-12T10:59:59.999Z"),
        intervalMinutes,
      }),
    ).toEqual({
      status: "overdue",
      label: "Sync overdue",
      description: "The last successful sync is overdue.",
    });
  });
});
