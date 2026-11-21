import { describe, expect, it } from "vitest";
import { runWithProviderIngestContext } from "../../db/provider-ingest-context.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { createMockDatabase } from "../test-helpers.ts";
import { intervalsIcuLocalDateWindow } from "./local-date-window.ts";

const HOME = "America/Los_Angeles";

function run(window: SyncWindow, options: Record<string, unknown> = {}) {
  return new SyncRun({ db: createMockDatabase().db, window, ...options });
}

describe("intervalsIcuLocalDateWindow", () => {
  it("keeps the UTC epoch lower bound and anchors the upper bound to the home timezone", async () => {
    const full = run(SyncWindow.full(new Date("2026-03-04T02:00:00.000Z")));

    const window = await runWithProviderIngestContext({ homeTimezone: HOME }, async () =>
      intervalsIcuLocalDateWindow(full),
    );

    expect(window).toEqual({ oldest: "1970-01-01", newest: "2026-03-03" });
  });

  it("passes explicit UTC range labels through unchanged", async () => {
    const explicit = run(
      SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-04" }),
    );

    const window = await runWithProviderIngestContext({ homeTimezone: HOME }, async () =>
      intervalsIcuLocalDateWindow(explicit),
    );

    expect(window).toEqual({ oldest: "2026-03-01", newest: "2026-03-04" });
  });

  it("re-anchors a relative window to the requested date in the home timezone", async () => {
    const requestedAt = new Date("2026-03-01T02:00:00.000Z");
    const relative = run(SyncWindow.lastDays(3, { now: requestedAt }), {
      requestedAt,
      relativeWindow: true,
    });

    const window = await runWithProviderIngestContext({ homeTimezone: HOME }, async () =>
      intervalsIcuLocalDateWindow(relative),
    );

    expect(window).toEqual({ oldest: "2026-02-25", newest: "2026-02-28" });
  });

  it("requires a fixed request time for a relative window", () => {
    const relative = run(SyncWindow.lastDays(3), { relativeWindow: true });

    expect(() => intervalsIcuLocalDateWindow(relative)).toThrow(/requires a fixed request time/);
  });
});
