import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";

const mockEnsureProvider = vi.fn().mockResolvedValue("kaya-export");
const mockUpsertProviderActivity = vi.fn().mockResolvedValue({ id: "activity-1" });

vi.mock("../../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
}));

vi.mock("../../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: (...args: unknown[]) => mockUpsertProviderActivity(...args),
}));

import { importKayaExportFile, type KayaImportDatabase, parseKayaExport } from "./import.ts";

const fixturePath = join(import.meta.dirname, "fixtures/representative-export.csv");
const fixtureText = readFileSync(fixturePath, "utf8");
const kayaHeader =
  "date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country";

function makeTransactionalImportDb(): {
  db: KayaImportDatabase;
  deleteWhere: CallableVitestMock;
  insertValues: CallableVitestMock;
  transactionDb: SyncDatabase;
} {
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFrom = vi.fn().mockReturnValue({ where: deleteWhere });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertInto = vi.fn().mockReturnValue({ values: insertValues });
  const transactionDb: SyncDatabase = {
    select: vi.fn(),
    insert: insertInto,
    delete: deleteFrom,
    execute: vi.fn(),
  };

  const db: KayaImportDatabase = {
    ...transactionDb,
    transaction: vi.fn(async (callback) => callback(transactionDb)),
  };

  return { db, deleteWhere, insertValues, transactionDb };
}

describe("parseKayaExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the observed Kaya CSV header exactly", () => {
    expect(fixtureText.split(/\r?\n/)[0]).toBe(kayaHeader);
  });

  it("groups rows into climbing activities by gym and UTC calendar day", () => {
    const result = parseKayaExport(fixtureText);

    expect(result.errors).toEqual([]);
    expect(result.activities).toHaveLength(3);
    expect(
      result.activities.map((activity) => ({
        externalId: activity.externalId,
        name: activity.name,
        locationName: activity.locationName,
        activityType: activity.activityType,
        startedAt: activity.startedAt.toISOString(),
        endedAt: activity.endedAt.toISOString(),
        entryCount: activity.entries.length,
      })),
    ).toEqual([
      {
        externalId: expect.stringMatching(/^kaya:session:/),
        name: "Kaya climbing at Touchstone Great Western Power Company",
        locationName: "Touchstone Great Western Power Company",
        activityType: "rock_climbing",
        startedAt: "2026-07-06T22:21:59.000Z",
        endedAt: "2026-07-06T22:23:07.000Z",
        entryCount: 2,
      },
      {
        externalId: expect.stringMatching(/^kaya:session:/),
        name: "Kaya climbing at Touchstone Great Western Power Company",
        locationName: "Touchstone Great Western Power Company",
        activityType: "rock_climbing",
        startedAt: "2026-07-08T15:09:12.000Z",
        endedAt: "2026-07-08T15:09:12.000Z",
        entryCount: 1,
      },
      {
        externalId: expect.stringMatching(/^kaya:session:/),
        name: "Kaya climbing at Touchstone Pacific Pipe",
        locationName: "Touchstone Pacific Pipe",
        activityType: "rock_climbing",
        startedAt: "2026-07-09T14:22:19.000Z",
        endedAt: "2026-07-09T15:17:17.000Z",
        entryCount: 3,
      },
    ]);
  });

  it("maps fixture rows to canonical climbing entries without expanding attempts", () => {
    const result = parseKayaExport(fixtureText);
    const pacificPipeSession = result.activities.find(
      (activity) => activity.locationName === "Touchstone Pacific Pipe",
    );

    expect(pacificPipeSession?.entries).toEqual([
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V0",
        sent: true,
        attemptCount: 1,
        routeName: null,
        locationName: "Touchstone Pacific Pipe",
        sourceName: "Kaya",
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V3",
        sent: true,
        attemptCount: 2,
        routeName: null,
        raw: expect.objectContaining({
          attempts: 2,
          ascentType: "Redpoint",
          color: "Pink",
          date: "Thu Jul 09 2026 14:55:40 GMT+0000 (GMT+00:00)",
          gym: "Touchstone Pacific Pipe",
          location: null,
          country: null,
          rating: null,
          stiffness: 0,
        }),
      }),
      expect.objectContaining({
        externalId: expect.stringMatching(/^kaya:entry:/),
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V3",
        sent: true,
        attemptCount: 1,
        routeName: null,
        raw: expect.objectContaining({
          attempts: 1,
          ascentType: "Onsight",
        }),
      }),
    ]);
  });

  it("uses climb_name as route name when present and null when empty", () => {
    const result = parseKayaExport(fixtureText);
    const greatWesternSession = result.activities[0];

    expect(greatWesternSession?.entries[0]?.routeName).toBeNull();
    expect(greatWesternSession?.entries[1]?.routeName).toBe("TCS #7");
  });

  it("generates deterministic external ids from stable row and session data", () => {
    const first = parseKayaExport(fixtureText);
    const second = parseKayaExport(fixtureText);

    expect(first.activities.map((activity) => activity.externalId)).toEqual(
      second.activities.map((activity) => activity.externalId),
    );
    expect(
      first.activities.flatMap((activity) => activity.entries.map((entry) => entry.externalId)),
    ).toEqual(
      second.activities.flatMap((activity) => activity.entries.map((entry) => entry.externalId)),
    );
    expect(first.activities.every((activity) => activity.externalId.length === 29)).toBe(true);
    expect(
      first.activities.every((activity) =>
        activity.entries.every((entry) => entry.externalId.length === 27),
      ),
    ).toBe(true);
  });

  it("uses stable entry hash inputs that distinguish route name, color, and row number", () => {
    const csv = `${kayaHeader}
Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,Route A,Touchstone Pacific Pipe,,
Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Blue,Route A,Touchstone Pacific Pipe,,
Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,Route B,Touchstone Pacific Pipe,,`;

    const entryIds = parseKayaExport(csv).activities.flatMap((activity) =>
      activity.entries.map((entry) => entry.externalId),
    );

    expect(new Set(entryIds).size).toBe(3);
  });

  it("maps Yosemite Decimal System rows to route climbs and trims nullable text fields", () => {
    const csv = `${kayaHeader}
 Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00) ,0,,Redpoint,,5.10a, Green , Lead Route , Touchstone Pacific Pipe , Oakland , USA `;

    const result = parseKayaExport(csv);

    expect(result.errors).toEqual([]);
    expect(result.activities[0]?.startedAt.toISOString()).toBe("2026-07-09T14:22:19.000Z");
    expect(result.activities[0]?.locationName).toBe("Touchstone Pacific Pipe");
    expect(result.activities[0]?.entries[0]).toMatchObject({
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.10a",
      lead: null,
      routeName: "Lead Route",
      locationName: "Touchstone Pacific Pipe",
      raw: {
        color: "Green",
        climbName: "Lead Route",
        location: "Oakland",
        country: "USA",
      },
    });
  });

  it("imports a flash as a successful first-attempt ascent", () => {
    const csv = `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Flash,1,v3,Pink,Named Problem,Touchstone Pacific Pipe,,`;

    const result = parseKayaExport(csv);

    expect(result.errors).toEqual([]);
    expect(result.activities[0]?.entries[0]).toMatchObject({
      sent: true,
      attemptCount: 1,
      routeName: "Named Problem",
      raw: expect.objectContaining({ ascentType: "Flash" }),
    });
  });

  it("reports invalid rows with specific messages", () => {
    const cases = [
      {
        csv: `${kayaHeader}\n,0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: date is required",
      },
      {
        csv: `${kayaHeader}\nnot-a-date,0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: date is not a valid Kaya date",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,,,,`,
        message: "row 2: gym is required",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,VBoulder,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: grade is unsupported",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Project,,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: ascent_type is unsupported",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,0,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: attempts must be a positive integer",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,2147483648,v3,Pink,,Touchstone Pacific Pipe,,`,
        message: "row 2: attempts must be a positive integer",
      },
      {
        csv: `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe`,
        message: "row 2: malformed CSV row",
      },
      {
        csv: "wrong,header\nvalue",
        message: "header does not match Kaya export format",
      },
    ];

    for (const testCase of cases) {
      expect(parseKayaExport(testCase.csv).errors).toContainEqual(
        expect.objectContaining({ message: testCase.message }),
      );
    }
  });

  it("accepts the largest Postgres integer attempt count", () => {
    const csv = `${kayaHeader}\nThu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,2147483647,v3,Pink,,Touchstone Pacific Pipe,,`;

    const result = parseKayaExport(csv);

    expect(result.errors).toEqual([]);
    expect(result.activities[0]?.entries[0]?.attemptCount).toBe(2_147_483_647);
  });

  it("preserves original CSV row numbers when blank lines are skipped", () => {
    const csv = `${kayaHeader}
Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,

not-a-date,0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,`;

    expect(parseKayaExport(csv).errors).toContainEqual(
      expect.objectContaining({ message: "row 4: date is not a valid Kaya date" }),
    );
  });

  it("handles BOM, CRLF rows, quoted commas, escaped quotes, and unterminated quotes", () => {
    const csv = `\uFEFF${kayaHeader}\r
Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Redpoint,,v3,Pink,"Route, With ""Quote""",Touchstone Pacific Pipe,,\r
`;

    const result = parseKayaExport(csv);
    expect(result.errors).toEqual([]);
    expect(result.activities[0]?.entries[0]?.routeName).toBe('Route, With "Quote"');
    expect(parseKayaExport(`${kayaHeader}\n"unterminated`).errors).toEqual([
      { rowNumber: 2, message: "row 2: malformed CSV row" },
    ]);
    expect(parseKayaExport(`${kayaHeader}\n   ,   ,   `).activities).toEqual([]);
  });

  it("imports provider activity and climbing entries inside a transaction", async () => {
    const { db, deleteWhere, insertValues, transactionDb } = makeTransactionalImportDb();

    const result = await importKayaExportFile(db, fixtureText, "user-1");

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockEnsureProvider).toHaveBeenCalledWith(
      transactionDb,
      "kaya-export",
      "Kaya",
      undefined,
      "user-1",
    );
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      transactionDb,
      expect.objectContaining({ providerId: "kaya-export", userId: "user-1" }),
      expect.any(Object),
    );
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      transactionDb,
      expect.objectContaining({
        raw: { locationName: "Touchstone Great Western Power Company", source: "kaya-export" },
      }),
      expect.objectContaining({
        raw: { locationName: "Touchstone Great Western Power Company", source: "kaya-export" },
      }),
    );
    expect(transactionDb.delete).toHaveBeenCalledTimes(3);
    expect(deleteWhere).toHaveBeenCalledTimes(3);
    expect(transactionDb.insert).toHaveBeenCalledTimes(3);
    expect(insertValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          activityId: "activity-1",
          externalId: expect.stringMatching(/^kaya:entry:[a-f0-9]{16}$/),
          grade: "V0",
          attemptCount: 1,
          sourceName: "Kaya",
        }),
      ]),
    );
    expect(result.recordsSynced).toBe(6);
  });

  it("returns parse errors with row external ids and import duration", async () => {
    const { db, transactionDb } = makeTransactionalImportDb();
    mockUpsertProviderActivity.mockResolvedValueOnce(undefined);
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(12_500);

    const result = await importKayaExportFile(
      db,
      `${kayaHeader}
not-a-date,0,,Redpoint,,v3,Pink,,Touchstone Pacific Pipe,,
Thu Jul 09 2026 14:22:19 GMT+0000 (GMT+00:00),0,,Project,,v3,Pink,,Touchstone Pacific Pipe,,`,
      "user-1",
    );

    expect(result).toMatchObject({
      provider: "kaya-export",
      recordsSynced: 0,
      duration: 2500,
      errors: [
        { message: "row 2: date is not a valid Kaya date", externalId: "row-2" },
        { message: "row 3: ascent_type is unsupported", externalId: "row-3" },
      ],
    });
    expect(mockEnsureProvider).toHaveBeenCalledWith(
      transactionDb,
      "kaya-export",
      "Kaya",
      undefined,
      "user-1",
    );
    expect(transactionDb.delete).not.toHaveBeenCalled();
    expect(transactionDb.insert).not.toHaveBeenCalled();

    dateNowSpy.mockRestore();
  });

  it("returns header parse errors without row external ids", async () => {
    const result = await importKayaExportFile(
      makeTransactionalImportDb().db,
      "wrong,header\nvalue",
      "user-1",
    );

    expect(result.errors).toEqual([
      {
        message: "header does not match Kaya export format",
        externalId: undefined,
      },
    ]);
  });
});
