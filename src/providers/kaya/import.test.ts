import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClimbingLogSessionsSyncInput } from "../../db/climbing-log-session-sync.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { makeTransactionalTestDatabase } from "../test-helpers.ts";

const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn().mockResolvedValue("kaya-export"),
  upsertActivity: vi.fn(),
  persist: vi.fn(async (_db: SyncDatabase, input: ClimbingLogSessionsSyncInput) => ({
    logEntryIds: [],
    recordsSynced:
      input.standaloneEntries.length +
      input.sessions.reduce((total, session) => total + session.entries.length, 0),
  })),
}));
vi.mock("../../db/tokens.ts", () => ({ ensureProvider: mocks.ensureProvider }));
vi.mock("../../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: mocks.upsertActivity,
}));
vi.mock("../../db/climbing-log-session-sync.ts", () => ({
  persistClimbingLogSessions: mocks.persist,
}));

import { importKayaExportFile, parseKayaExport } from "./import.ts";

const fixture = readFileSync(
  join(import.meta.dirname, "fixtures/representative-export.csv"),
  "utf8",
);
const header =
  "date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country";
const row = (
  label = "Redpoint",
  count = "2",
  grade = "v3",
  date = "2026-09-01T12:00:00Z",
  gym = "Test Gym",
) => `${date},0,,${label},${count},${grade},Blue,Test Climb,${gym},,`;
const csv = (...rows: string[]) => [header, ...rows].join("\n");
const entries = (result: ReturnType<typeof parseKayaExport>) => [
  ...result.standaloneEntries,
  ...result.sessions.flatMap((session) => session.entries),
];
function database() {
  return makeTransactionalTestDatabase({
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsertActivity.mockReset().mockResolvedValue({ id: "activity-1" });
});
describe("parseKayaExport", () => {
  it("groups supplied gym and date rows into the existing UTC-day sessions", () => {
    const result = parseKayaExport(fixture);
    expect(result.errors).toEqual([]);
    expect(
      result.sessions.map((session) => ({
        name: session.name,
        count: session.entries.length,
        start: session.startedAt.toISOString(),
        end: session.endedAt.toISOString(),
      })),
    ).toEqual([
      {
        name: "Kaya climbing at Touchstone Great Western Power Company",
        count: 2,
        start: "2026-07-06T22:21:59.000Z",
        end: "2026-07-06T22:23:07.000Z",
      },
      {
        name: "Kaya climbing at Touchstone Great Western Power Company",
        count: 1,
        start: "2026-07-08T15:09:12.000Z",
        end: "2026-07-08T15:09:12.000Z",
      },
      {
        name: "Kaya climbing at Touchstone Pacific Pipe",
        count: 3,
        start: "2026-07-09T14:22:19.000Z",
        end: "2026-07-09T15:17:17.000Z",
      },
    ]);
  });
  it("keeps row grades as reported data and source counts for scoped expansion", () => {
    const parsed = parseKayaExport(csv(row("Flash", "1")));
    expect(parsed.errors).toEqual([]);
    expect(entries(parsed)).toEqual([
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbedOn: "2026-09-01",
        reportedGrades: [{ value: "V3", system: "v_scale" }],
        reportedAttemptCounts: [{ scope: "climb", count: 1 }],
        attempts: [{ scope: "climb", qualifier: "free-flash" }],
        climb: {
          externalId: null,
          name: "Test Climb",
          kind: "boulder",
          setting: "indoor",
          areas: [{ name: "Test Gym", externalId: null }],
        },
        raw: expect.objectContaining({ grade: "v3", ascentType: "Flash", attempts: 1 }),
      }),
    ]);
  });
  it("retains missing grade date and gym as standalone logs", () => {
    const parsed = parseKayaExport(
      csv(row("", "", "", "", ""), row("", "", "Source scale 4", "2026-09-01T12:00:00Z", "")),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.sessions).toEqual([]);
    expect(parsed.standaloneEntries).toEqual([
      expect.objectContaining({
        climbedOn: null,
        reportedGrades: [],
        attempts: [{ scope: "climb" }],
        climb: expect.objectContaining({
          externalId: null,
          name: "Test Climb",
          kind: null,
          setting: null,
        }),
      }),
      expect.objectContaining({
        climbedOn: "2026-09-01",
        reportedGrades: [{ value: "Source scale 4", system: null }],
        climb: expect.objectContaining({ kind: null, setting: null }),
      }),
    ]);
  });
  it("uses source route names and trims location text", () => {
    const parsed = parseKayaExport(
      csv(
        "2026-09-01T12:00:00Z,0,,Redpoint,,5.10a, Green , Lead Route , Test Gym , Oakland , USA ",
      ),
    );
    expect(entries(parsed)[0]).toMatchObject({
      reportedGrades: [{ value: "5.10a", system: "yds" }],
      climb: { kind: "route", name: "Lead Route", areas: [{ name: "Test Gym", externalId: null }] },
      raw: { color: "Green", location: "Oakland", country: "USA" },
    });
  });
  it("keeps deterministic distinct row identities without inventing catalogue IDs", () => {
    const source = csv(row(), row(), row().replace("Test Climb", "Other Climb"));
    const first = entries(parseKayaExport(source));
    expect(first.map((entry) => entry.externalId)).toEqual(
      entries(parseKayaExport(source)).map((entry) => entry.externalId),
    );
    expect(new Set(first.map((entry) => entry.externalId)).size).toBe(3);
    expect(first.map((entry) => entry.climb?.externalId)).toEqual([null, null, null]);
  });
  it.each(["Project", "Attempt", "Frenchfree", "Unfamiliar result", "", " Attempt "])(
    "retains unknown completion for %j",
    (label) => {
      expect(entries(parseKayaExport(csv(row(label, ""))))[0]).toMatchObject({
        attempts: [{ scope: "climb" }],
        raw: { ascentType: label, attempts: null },
      });
    },
  );
  it.each([
    ["not-a-date", "2", "date is not a valid Kaya date"],
    ["2026-02-30", "2", "date is not a valid Kaya date"],
    ["2026-09-01", "0", "attempts must be a positive integer"],
    ["2026-09-01", "2.5", "attempts must be a positive integer"],
    ["2026-09-01", "2147483648", "attempts must be a positive integer"],
  ])("rejects malformed supplied values %s/%s", (date, count, message) => {
    expect(parseKayaExport(csv(row("Redpoint", count, "v3", date))).errors).toEqual([
      { rowNumber: 2, message: `row 2: ${message}` },
    ]);
  });
  it("preserves the positive Postgres count bound without expanding during parsing", () => {
    expect(
      entries(parseKayaExport(csv(row("Redpoint", "2147483647"))))[0]?.reportedAttemptCounts,
    ).toEqual([{ scope: "climb", count: 2147483647 }]);
  });
  it("handles BOM CRLF quotes commas and original error row numbers", () => {
    const source =
      "\uFEFF" +
      header +
      "\r\n" +
      row().replace("Test Climb", '"Route, With ""Quote"""') +
      "\r\n\r\n" +
      row("Redpoint", "2", "v3", "not-a-date") +
      "\r\n";
    const parsed = parseKayaExport(source);
    expect(entries(parsed)[0]?.climb?.name).toBe('Route, With "Quote"');
    expect(parsed.errors[0]?.rowNumber).toBe(4);
    expect(parseKayaExport(`${header}\n"unterminated`).errors).toEqual([
      { rowNumber: 2, message: "row 2: malformed CSV row" },
    ]);
    expect(parseKayaExport("wrong,header\nvalue").errors).toEqual([
      { rowNumber: null, message: "header does not match Kaya export format" },
    ]);
    expect(entries(parseKayaExport(`${header}\n   ,   ,   `))).toEqual([]);
  });
});
describe("importKayaExportFile", () => {
  it("persists the complete batch inside the activity transaction", async () => {
    const db = database();
    vi.spyOn(db, "transaction");
    expect(await importKayaExportFile(db, fixture, "user-1")).toMatchObject({
      recordsSynced: 6,
      errors: [],
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(mocks.ensureProvider).toHaveBeenCalledWith(
      db,
      "kaya-export",
      "Kaya",
      undefined,
      "user-1",
    );
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.persist.mock.calls[0]?.[1].sessions).toHaveLength(3);
    expect(mocks.persist.mock.calls[0]?.[1].sessions.every((session) => session.complete)).toBe(
      true,
    );
  });
  it("imports standalone missing fields without fabricating a session", async () => {
    expect(
      await importKayaExportFile(database(), csv(row("", "", "", "", "")), "user-1"),
    ).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(mocks.upsertActivity).not.toHaveBeenCalled();
    expect(mocks.persist.mock.calls[0]?.[1].standaloneEntries).toHaveLength(1);
  });
  it("keeps valid records without retirement after a partial import", async () => {
    expect(
      await importKayaExportFile(
        database(),
        csv(row(), row("Redpoint", "2", "v3", "not-a-date")),
        "user-1",
      ),
    ).toMatchObject({
      recordsSynced: 1,
      errors: [{ message: "row 3: date is not a valid Kaya date", externalId: "row-3" }],
    });
    expect(mocks.persist.mock.calls[0]?.[1].sessions[0]?.complete).toBe(false);
  });
  it("respects a suppressed activity upsert", async () => {
    mocks.upsertActivity.mockResolvedValueOnce(undefined);
    expect(await importKayaExportFile(database(), csv(row()), "user-1")).toMatchObject({
      recordsSynced: 0,
      errors: [],
    });
    expect(mocks.persist.mock.calls[0]?.[1].sessions).toEqual([]);
  });
  it("reports invalid headers with no row identity", async () => {
    expect(
      (await importKayaExportFile(database(), "wrong,header\nvalue", "user-1")).errors,
    ).toEqual([{ message: "header does not match Kaya export format", externalId: undefined }]);
  });
});
