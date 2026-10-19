import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { type createMockDatabase, theCragPage } from "./test-helpers.ts";

export function response(
  ascents: Record<string, unknown>[] = [],
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify(theCragPage(ascents, overrides)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function tokens(accountId = "123") {
  return {
    accessToken: "personal-key",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "logbook:read",
    providerAccountId: accountId,
  };
}

export function makeRun(
  database: ReturnType<typeof createMockDatabase>["db"],
  options: { full?: boolean; origin?: "scheduled" | "manual"; userId?: string } = {},
): SyncRun {
  return new SyncRun({
    db: database,
    window:
      options.full === false
        ? SyncWindow.fromDateRange({ sinceDate: "2026-10-01", untilDate: "2026-10-11" })
        : SyncWindow.full(new Date("2026-10-11T23:59:59.999Z")),
    userId: options.userId ?? "00000000-0000-0000-0000-000000000001",
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
