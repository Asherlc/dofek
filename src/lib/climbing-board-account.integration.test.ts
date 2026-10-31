import { eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { area, climb, climbingAttempt, climbingLogEntry } from "../db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { AuroraBoardProvider } from "../providers/aurora-board.ts";
import { DecoyProvider } from "../providers/decoy.ts";
import { GrasshopperProvider } from "../providers/grasshopper.ts";
import { KilterProvider } from "../providers/kilter.ts";
import { SoillProvider } from "../providers/soill.ts";
import { SyncRun } from "../providers/sync-run.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import { TensionProvider } from "../providers/tension.ts";
import { TouchstoneProvider } from "../providers/touchstone.ts";
import type { SyncProvider } from "../providers/types.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";

const otherUser = "00000000-0000-4000-8000-000000009902";
const auroraProviders = [
  new TensionProvider(),
  new GrasshopperProvider(),
  new DecoyProvider(),
  new SoillProvider(),
  new TouchstoneProvider(),
  new AuroraBoardProvider(),
];
const kilterLog = {
  logUuid: "one",
  userUuid: "owner",
  climbUuid: "problem",
  climbName: "Problem",
  angle: 40,
  createdAt: "2026-10-01T23:30:00Z",
  attempts: 3,
  topped: true,
  currentDifficultyId: 20,
};
const ascent = {
  uuid: "one",
  user_id: 42,
  climb_uuid: "problem",
  angle: 40,
  climbed_at: "2026-10-01 23:30:00",
  is_listed: true,
  difficulty: 20,
  attempt_id: 2,
  bid_count: 8,
};
const bid = {
  uuid: "one",
  user_id: 42,
  climb_uuid: "problem",
  angle: 40,
  climbed_at: "2026-10-02 00:00:00",
  bid_count: 2,
};
const server = createIntegrationMswFixture();

describe("board account canonical persistence", () => {
  let context: TestContext;
  let logs: unknown;
  let pages: unknown[];
  let pageIndex: number;

  beforeAll(async () => {
    context = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id,name) VALUES (${otherUser},'Other owner')`,
    );
    for (const provider of [new KilterProvider(), ...auroraProviders]) {
      for (const owner of [userId, otherUser]) {
        await ensureProvider(context.db, provider.id, provider.name, undefined, owner);
        await saveTokens(
          context.db,
          provider.id,
          {
            accessToken: "access",
            refreshToken: provider.id === "kilter" ? "refresh" : null,
            expiresAt: new Date("2099-01-01"),
            scopes: null,
            providerAccountId: "42",
          },
          owner,
        );
      }
    }
  });
  beforeEach(() => {
    logs = [kilterLog];
    pages = [{ ascents: [ascent], bids: [bid], _complete: true }];
    pageIndex = 0;
    server.use(
      http.get("https://portal.kiltergrips.com/api/logs", () =>
        HttpResponse.json(z.json().parse(logs)),
      ),
      http.get("https://portal.kiltergrips.com/api/grades", () =>
        HttpResponse.json([{ difficultyGradeId: 20, vScale: "V5", fontScale: "6C" }]),
      ),
      http.post(
        /^https:\/\/(?:tensionboardapp2|grasshopperboardapp|decoyboardapp|soillboardapp|touchstoneboardapp|auroraboardapp)\.com\/sync$/,
        () => HttpResponse.json(z.json().parse(pages[Math.min(pageIndex++, pages.length - 1)])),
      ),
    );
  });
  afterEach(async () => {
    server.resetHandlers();
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
  });
  afterAll(async () => {
    server.deactivate();
    await context.cleanup();
  });

  const run = (provider: SyncProvider, owner = userId) =>
    provider.sync(
      new SyncRun({
        db: context.db,
        userId: owner,
        window: SyncWindow.full(new Date("2026-10-03T00:00:00Z")),
      }),
    );
  const stored = () =>
    context.db
      .select()
      .from(climbingLogEntry)
      .orderBy(climbingLogEntry.userId, climbingLogEntry.providerId, climbingLogEntry.externalId);

  it("requires an explicit owner before reading credentials or importing source data", async () => {
    const result = await new KilterProvider().sync(
      new SyncRun({ db: context.db, window: SyncWindow.full() }),
    );
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "Kilter Board sync requires a user context." })],
    });
    expect(await stored()).toEqual([]);
  });

  it("keeps Kilter occurrence IDs and only the described completion while expanding a raw count", async () => {
    const provider = new KilterProvider();
    expect(await run(provider)).toMatchObject({ errors: [], recordsSynced: 1 });
    const before = await stored();
    const attempts = await context.db.select().from(climbingAttempt);
    expect(before).toEqual([
      expect.objectContaining({
        externalId: "kilter:log:one",
        activityId: null,
        raw: kilterLog,
        climbedOn: "2026-10-01",
      }),
    ]);
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.sourceCompleted === true)).toHaveLength(1);
    expect(attempts.every((attempt) => attempt.sourceResult === null)).toBe(true);
    const outcomes = await executeWithSchema(
      context.db,
      z.object({ outcome: z.string().nullable() }),
      sql`SELECT outcome FROM fitness.v_climbing_attempt`,
    );
    expect(outcomes.filter((attempt) => attempt.outcome === "completed")).toHaveLength(1);
    expect(outcomes.filter((attempt) => attempt.outcome === null)).toHaveLength(2);
    expect(await run(provider)).toMatchObject({ errors: [] });
    expect(await stored()).toEqual(before);
    expect(
      (await context.db.select().from(climbingAttempt)).map((attempt) => attempt.id).sort(),
    ).toEqual(attempts.map((attempt) => attempt.id).sort());
  });

  it("retires absent Kilter logs only for the completed owner's provider snapshot", async () => {
    const provider = new KilterProvider();
    expect(await run(provider)).toMatchObject({ errors: [] });
    expect(await run(provider, otherUser)).toMatchObject({ errors: [] });
    expect(await run(new TensionProvider())).toMatchObject({ errors: [] });
    logs = [];
    expect(await run(provider)).toMatchObject({ errors: [] });
    const rows = await stored();
    expect(
      rows.find((row) => row.providerId === "kilter" && row.userId === userId)?.providerAbsentAt,
    ).toBeInstanceOf(Date);
    expect(
      rows
        .filter((row) => row.providerId !== "kilter" || row.userId !== userId)
        .every((row) => row.providerAbsentAt === null),
    ).toBe(true);
    logs = [kilterLog];
    expect(await run(provider)).toMatchObject({ errors: [] });
    expect((await stored()).every((row) => row.providerAbsentAt === null)).toBe(true);
  });

  it.each([true, false])(
    "clears an explicitly unknown Kilter completion after %s without changing attempt identities",
    async (completed) => {
      const provider = new KilterProvider();
      logs = [{ ...kilterLog, topped: completed, flashed: false }];
      expect(await run(provider)).toMatchObject({ errors: [] });
      const before = await context.db.select().from(climbingAttempt);
      expect(before).toHaveLength(3);
      expect(before.filter((attempt) => attempt.sourceCompleted === completed)).toHaveLength(1);
      const updatedLog = { ...kilterLog, topped: null, flashed: false };
      logs = [updatedLog];
      expect(await run(provider)).toMatchObject({ errors: [] });
      const after = await context.db.select().from(climbingAttempt);
      expect(after.map((attempt) => attempt.id).sort()).toEqual(
        before.map((attempt) => attempt.id).sort(),
      );
      expect(
        after.every(
          (attempt) =>
            attempt.sourceCompleted === null &&
            attempt.sourceResult === null &&
            attempt.attemptIndex === null &&
            attempt.receivedBeta === null,
        ),
      ).toBe(true);
      const outcomes = await executeWithSchema(
        context.db,
        z.object({ outcome: z.string().nullable() }),
        sql`SELECT outcome FROM fitness.v_climbing_attempt`,
      );
      expect(outcomes).toEqual([{ outcome: null }, { outcome: null }, { outcome: null }]);
      expect((await stored())[0]?.raw).toEqual(updatedLog);
    },
  );

  it.each([true, false])(
    "preserves prior Kilter completion %s when a refresh truly omits the fact",
    async (completed) => {
      const provider = new KilterProvider();
      logs = [{ ...kilterLog, topped: completed, flashed: false }];
      expect(await run(provider)).toMatchObject({ errors: [] });
      const before = await context.db.select().from(climbingAttempt);
      logs = [
        {
          logUuid: kilterLog.logUuid,
          climbUuid: kilterLog.climbUuid,
          createdAt: kilterLog.createdAt,
          attempts: 3,
        },
      ];
      expect(await run(provider)).toMatchObject({ errors: [] });
      const after = await context.db.select().from(climbingAttempt);
      expect(after.map((attempt) => attempt.id).sort()).toEqual(
        before.map((attempt) => attempt.id).sort(),
      );
      expect(after.filter((attempt) => attempt.sourceCompleted === completed)).toHaveLength(1);
      expect(after.filter((attempt) => attempt.sourceCompleted === null)).toHaveLength(2);
    },
  );

  it.each([false, null])(
    "keeps flash-derived order and beta unknown when flashed changes from true to %s",
    async (flashed) => {
      const provider = new KilterProvider();
      logs = [{ ...kilterLog, attempts: 1, topped: null, flashed: true }];
      expect(await run(provider)).toMatchObject({ errors: [] });
      const before = await context.db.select().from(climbingAttempt);
      expect(before).toEqual([
        expect.objectContaining({
          sourceCompleted: true,
          attemptIndex: null,
          receivedBeta: null,
          sourceResult: null,
        }),
      ]);
      logs = [{ ...kilterLog, attempts: 1, topped: null, flashed }];
      expect(await run(provider)).toMatchObject({ errors: [] });
      expect(await context.db.select().from(climbingAttempt)).toEqual([
        expect.objectContaining({
          id: before[0]?.id,
          sourceCompleted: null,
          attemptIndex: null,
          receivedBeta: null,
          sourceResult: null,
        }),
      ]);
    },
  );

  it("does not reconcile Kilter absence on malformed source data", async () => {
    const provider = new KilterProvider();
    await run(provider);
    const before = await stored();
    logs = {};
    expect(await run(provider)).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await stored()).toEqual(before);
  });

  it.each(auroraProviders)(
    "retains separate raw sends and bids for $name without inferring counts/grades",
    async (provider) => {
      expect(await run(provider)).toMatchObject({ errors: [], recordsSynced: 2 });
      const rows = await stored();
      expect(rows.map((row) => row.externalId).sort()).toEqual([
        `${provider.id}:ascent:one`,
        `${provider.id}:bid:one`,
      ]);
      expect(rows.every((row) => row.activityId === null)).toBe(true);
      expect(rows.find((row) => row.externalId?.includes(":ascent:"))?.raw).toEqual(ascent);
      const attempts = await context.db.select().from(climbingAttempt);
      expect(attempts).toHaveLength(3);
      expect(attempts.filter((attempt) => attempt.sourceCompleted === true)).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.sourceCompleted === false)).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.sourceCompleted === null)).toHaveLength(1);
      pages = [{ ascents: [], bids: [], _complete: true }];
      expect(await run(provider)).toMatchObject({ errors: [], recordsSynced: 0 });
      expect(await stored()).toEqual(rows);
    },
  );

  it("applies explicit Aurora tombstones by source kind and owner, then restores the same identity", async () => {
    const provider = new TensionProvider();
    await run(provider);
    await run(provider, otherUser);
    const before = await stored();
    pages = [
      { ascents: [{ uuid: "one", user_id: 42, is_listed: false }], bids: [], _complete: true },
    ];
    expect(await run(provider)).toMatchObject({ errors: [], recordsSynced: 0 });
    const rows = await stored();
    expect(
      rows.find((row) => row.userId === userId && row.externalId === "tension:ascent:one")
        ?.providerAbsentAt,
    ).toBeInstanceOf(Date);
    expect(
      rows
        .filter((row) => row.userId !== userId || row.externalId !== "tension:ascent:one")
        .every((row) => row.providerAbsentAt === null),
    ).toBe(true);
    pages = [{ ascents: [ascent], bids: [], _complete: true }];
    expect(await run(provider)).toMatchObject({ errors: [] });
    expect(await stored()).toEqual(before);
  });

  it("writes no partial pages or tombstones if later pagination fails", async () => {
    const provider = new TensionProvider();
    await run(provider);
    const before = await stored();
    pageIndex = 0;
    pages = [
      {
        ascents: [
          { ...ascent, uuid: "new" },
          { uuid: "one", user_id: 42, is_listed: false },
        ],
        bids: [],
        user_syncs: [
          {
            user_id: 42,
            table_name: "ascents",
            last_synchronized_at: "2026-10-03 00:00:00.000000",
          },
        ],
        _complete: false,
      },
      { ascents: [{ ...ascent, uuid: "bad", climbed_at: "invalid" }], bids: [], _complete: true },
    ];
    expect(await run(provider)).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await stored()).toEqual(before);
  });

  it("persists a rotated Kilter refresh credential before a later catalog failure", async () => {
    await saveTokens(
      context.db,
      "kilter",
      { accessToken: "old", refreshToken: "refresh", expiresAt: new Date(0), scopes: null },
      userId,
    );
    server.use(
      http.post("https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token", () =>
        HttpResponse.json({
          access_token: "new-access",
          refresh_token: "rotated",
          expires_in: 300,
        }),
      ),
      http.get("https://portal.kiltergrips.com/api/grades", () =>
        HttpResponse.json({ malformed: true }),
      ),
    );
    expect(await run(new KilterProvider())).toMatchObject({
      recordsSynced: 0,
      errors: [expect.any(Object)],
    });
    expect(await loadTokens(context.db, "kilter", userId)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "rotated",
    });
    expect(await stored()).toEqual([]);
    expect(
      await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.userId, userId)),
    ).toEqual([]);
  });
});
