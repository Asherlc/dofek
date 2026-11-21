import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, expect, it } from "vitest";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import { runningRaceResult } from "../db/schema/activity.ts";
import { userProfile } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { connectProviderWithTokens } from "../db/tokens.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { authFailureReasonFromError } from "./auth-errors.ts";
import { RunalyzeProvider } from "./runalyze.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const server = createIntegrationMswFixture();
const provider = new RunalyzeProvider();
const base = "https://runalyze.com/api/v1";
let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
  server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
});

afterAll(async () => {
  server.deactivate();
  await ctx?.cleanup();
});

it("replaces only a fully resolved owner snapshot", async () => {
  const userId = process.env.TEST_TOKEN_USER_ID;
  if (!userId) throw new Error("TEST_TOKEN_USER_ID is required");
  await connectProviderWithTokens(
    ctx.db,
    { id: provider.id, name: provider.name, apiBaseUrl: base },
    {
      accessToken: "test-token",
      refreshToken: null,
      expiresAt: new Date("2099-12-31T00:00:00Z"),
      scopes: "self",
    },
    userId,
  );
  const race = {
    date: "2026-04-01T09:00:00+02:00",
    activity_id: 42,
    name: "Spring 5K",
    official_distance: 5,
    official_time: 1500.25,
    status: "completed",
  };
  const otherUserId = randomUUID();
  await ctx.db.insert(userProfile).values({ id: otherUserId, name: "Other runner" });
  await ctx.db.insert(runningRaceResult).values({
    userId: otherUserId,
    providerId: provider.id,
    sourceActivityId: "42",
    sourceSport: "Running",
    sourceDateTime: race.date,
    distanceMeters: 5000,
    finishSeconds: 1800,
  });
  let inventory: (Omit<typeof race, "official_time"> & {
    official_time: number | string | null;
  })[] = [
    ...Array.from({ length: 96 }, (_, index) => ({
      ...race,
      activity_id: 100 + index,
      status: "dnf",
    })),
    race,
    { ...race, activity_id: 43 },
    { ...race, activity_id: 44 },
    { ...race, activity_id: 45, official_time: null },
  ];
  let secondPage = [{ ...race, activity_id: 46 }];
  let activityStatus = 200;
  let omitLinkedActivity = false;
  let secondPageStatus = 200;
  server.use(
    http.get(`${base}/raceresult`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("order[activity.time]")).toBe("asc");
      if (params.get("page") === "2" && secondPageStatus !== 200) {
        return new HttpResponse(null, { status: secondPageStatus });
      }
      return HttpResponse.json(params.get("page") === "1" ? inventory : secondPage);
    }),
    http.get(`${base}/activity`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("id")?.split(",")).toEqual([
        "42",
        "43",
        "44",
        "46",
      ]);
      return activityStatus === 200
        ? HttpResponse.json([
            { id: 42, sport: { name: "RUNNING" }, is_virtual: false },
            { id: 43, sport: { name: "Cycling" }, is_virtual: false },
            { id: 44, sport: { name: "Running" }, is_virtual: true },
            ...(omitLinkedActivity ? [] : [{ id: 46, is_virtual: false }]),
          ])
        : new HttpResponse(null, { status: activityStatus });
    }),
  );
  const sync = () =>
    provider.sync(
      new SyncRun({
        db: ctx.db,
        userId,
        window: SyncWindow.fromSince({ since: new Date("2026-11-01T00:00:00Z") }),
      }),
    );
  const rows = () =>
    ctx.db.select().from(runningRaceResult).where(eq(runningRaceResult.userId, userId));
  await expect(sync()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
  await expect(sync()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
  expect(await rows()).toMatchObject([
    {
      userId,
      providerId: "runalyze",
      sourceActivityId: "42",
      sourceDateTime: race.date,
      distanceMeters: 5000,
      finishSeconds: 1500.25,
    },
  ]);
  inventory = Array.from({ length: 100 }, (_, index) =>
    index === 0
      ? { ...race, official_time: 1510.25 }
      : { ...race, activity_id: 100 + index, status: "dnf" },
  );
  secondPage = [43, 44, 46].map((activity_id) => ({ ...race, activity_id }));
  await expect(sync()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
  expect(await rows()).toMatchObject([{ finishSeconds: 1510.25 }]);
  secondPageStatus = 400;
  expect((await sync()).errors).toHaveLength(1);
  expect(await rows()).toMatchObject([{ finishSeconds: 1510.25 }]);
  secondPageStatus = 200;
  inventory[0] = { ...race, official_time: 1520.25 };
  omitLinkedActivity = true;
  await expect(sync()).resolves.toMatchObject({
    recordsSynced: 0,
    errors: [{ message: "Runalyze omitted requested linked activities." }],
  });
  expect(await rows()).toMatchObject([{ finishSeconds: 1510.25 }]);
  omitLinkedActivity = false;
  activityStatus = 403;
  const syncFailure = await sync();
  expect(authFailureReasonFromError(syncFailure.errors[0]?.cause)).toBe("authentication_failed");
  expect(await rows()).toHaveLength(1);
  activityStatus = 200;
  inventory = [{ ...race, official_time: "invalid" }];
  expect((await sync()).errors).toHaveLength(1);
  expect(await rows()).toHaveLength(1);
  inventory = [];
  await expect(sync()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
  expect(await rows()).toEqual([]);
  expect(await ctx.db.select().from(runningRaceResult)).toMatchObject([
    { userId: otherUserId, finishSeconds: 1800 },
  ]);
  const finish = {
    userId,
    providerId: provider.id,
    sourceActivityId: "42",
    sourceSport: "Running",
    sourceDateTime: race.date,
    distanceMeters: 5000,
    finishSeconds: 1500.25,
  };
  await ctx.db.insert(runningRaceResult).values(finish);
  const requestId = randomUUID();
  await ctx.db.execute(sql`INSERT INTO fitness.account_erasure_request
    (id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash, replay_retained_until, completion_deadline)
    VALUES (${requestId}::uuid, ${userId}::uuid, ${"1".repeat(64)}, 'test-key',
      ${"2".repeat(64)}, ${"3".repeat(64)}, now()+interval '7 days', now()+interval '30 days')`);
  await expect(
    ctx.db.insert(runningRaceResult).values({ ...finish, sourceActivityId: "47" }),
  ).rejects.toMatchObject({
    cause: { code: "55000", message: expect.stringContaining("Account erasure is active") },
  });
  await erasePostgresAccount(ctx.db, requestId, userId);
  expect(await rows()).toEqual([]);
  expect(await ctx.db.select().from(runningRaceResult)).toMatchObject([{ userId: otherUserId }]);
});
