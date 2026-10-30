import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import type { createMockDatabase } from "../test-helpers.ts";

export function apiAscent(overrides: Record<string, unknown> = {}) {
  return {
    id: "1001",
    epoch: 1791676800,
    date: "2026-10-10",
    climbedGearStyle: "top rope",
    tick: { label: "attempt", name: "Attempt: Top rope" },
    markdown: "Private training notes",
    route: { id: "2001", name: "Sample route", grade: "5.10b", style: "Top rope" },
    ...overrides,
  };
}

export function logbookPage(ascents = [apiAscent()], overrides: Record<string, unknown> = {}) {
  return {
    data: {
      account: { id: "123", login: "sampleclimber" },
      ascents,
      numberAscents: ascents.length,
      page: "1",
      perPage: 250,
      ...overrides,
    },
  };
}

export function makeRun(
  database: ReturnType<typeof createMockDatabase>["db"],
  options: { full?: boolean; origin?: "scheduled" | "manual"; userId?: string | null } = {},
): SyncRun {
  return new SyncRun({
    db: database,
    window:
      options.full === false
        ? SyncWindow.fromDateRange({ sinceDate: "2026-10-01", untilDate: "2026-10-11" })
        : SyncWindow.full(new Date("2026-10-11T23:59:59.999Z")),
    userId:
      options.userId === null
        ? undefined
        : (options.userId ?? "00000000-0000-0000-0000-000000000001"),
    origin: options.origin,
  });
}

export const gradeCases = [
  ["V4", "Boulder", "boulder", "v_scale", "V4"],
  [" V10 ", "Boulder", "boulder", "v_scale", "V10"],
  ["VB+", "Boulder", "boulder", "v_scale", "VB+"],
  ["5.10a", "Sport", "sport", "yds", "5.10a"],
  ["FR 6a", "Sport", "sport", "french", "6a"],
  ["FB 6A", "Boulder", "boulder", "font", "6A"],
  ["AU 19", "Trad", "trad", "ewbank", "19"],
  ["UIAA 7", "Trad", "trad", "uiaa", "7"],
  ["FR:6a", "Sport", "sport", "french", "6a"],
  ["FB:6A", "Boulder", "boulder", "font", "6A"],
  ["AU:19", "Trad", "trad", "ewbank", "19"],
  ["UIAA:7", "Trad", "trad", "uiaa", "7"],
  ["YDS:5.10a", "Sport", "sport", "yds", "5.10a"],
  ["BLDV:V3", "Boulder", "boulder", "v_scale", "V3"],
  ["FR:  6a", "Sport", "sport", "french", "6a"],
  ["FR \n6a", "Sport", "sport", "french", "6a"],
  ["AID A2", "Aid", "aid", "aid", "A2"],
  ["AIDC C2+", "Aid", "aid", "aid", "C2+"],
  ["WICE WI4+", "Ice", "ice", "water_ice", "WI4+"],
  ["AICE AI3", "Ice", "ice", "alpine_ice", "AI3"],
  ["MIXED M6+", "Mixed", "mixed", "mixed", "M6+"],
  ["IFAS AD+", "Alpine", "alpine", "ifas", "AD+"],
  ["NCCS VI", "Alpine", "alpine", "nccs", "VI"],
  ["UK E3", "Trad", "trad", "british_adjectival", "E3"],
  ["UKT 5c", "Trad", "trad", "british_technical", "5c"],
];
