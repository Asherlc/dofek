import { afterEach, describe, expect, it, vi } from "vitest";
import { syncHealth } from "./sync-health.ts";

describe("syncHealth", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a recent successful sync as fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));

    expect(
      syncHealth({
        providerId: "wahoo",
        lastSuccess: "2026-09-02T11:00:00Z",
        lastAttempt: "2026-09-02T11:00:00Z",
        lastError: null,
        consecutiveFailures: 0,
      }),
    ).toEqual({
      last_success: "2026-09-02T11:00:00Z",
      last_attempt: "2026-09-02T11:00:00Z",
      last_error: null,
      consecutive_failures: 0,
      expected_sync_interval_minutes: 30,
      stale: false,
    });
  });

  it("reports missing sync health as stale", () => {
    expect(syncHealth(undefined)).toEqual({
      last_success: null,
      last_attempt: null,
      last_error: null,
      consecutive_failures: 0,
      expected_sync_interval_minutes: 30,
      stale: true,
    });
  });

  it("explains when a stale provider is deferred by an active rate-limit cooldown", () => {
    expect(
      syncHealth(undefined, {
        expiresAt: new Date("2026-09-04T04:32:46.000Z"),
      }),
    ).toEqual({
      last_success: null,
      last_attempt: null,
      last_error: "Rate limited; sync deferred until 2026-09-04T04:32:46.000Z",
      consecutive_failures: 0,
      expected_sync_interval_minutes: 30,
      stale: true,
    });
  });
});
