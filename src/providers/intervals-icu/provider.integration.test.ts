import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity } from "../../db/schema/activity.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { createIntegrationMswFixture } from "../../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { createCapturingMetricStreamPublisher } from "../test-helpers.ts";
import { IntervalsIcuProvider } from "./provider.ts";

const API = "https://intervals.icu/api/v1";
const PROVIDER_ID = "intervals.icu";
const server = createIntegrationMswFixture();
const capture = createCapturingMetricStreamPublisher();

type JsonBody = Parameters<typeof HttpResponse.json>[0];

const activityFixture = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "Ride",
  name: "Morning ride",
  start_date: "2026-03-01T10:00:00Z",
  start_date_local: "2026-03-01T05:00:00",
  timezone: "America/New_York",
  elapsed_time: 3600,
  device_name: "Garmin Edge",
  device_watts: true,
  ...overrides,
});

const restrictedStub = (id: string) => ({
  id,
  source: "STRAVA",
  _note: "restricted by Strava API terms",
});

const streamsFixture = [
  { type: "time", data: [0, 1, 2] },
  { type: "heartrate", data: [120, null, 0] },
  { type: "watts", data: [200, 210, 220] },
  { type: "latlng", data: [40.1, 40.2, 40.3], data2: [-73.1, -73.2, -73.3] },
];

function useList(body: JsonBody, onRequest?: (url: URL) => void) {
  server.use(
    http.get(`${API}/athlete/0/activities`, ({ request }) => {
      onRequest?.(new URL(request.url));
      return HttpResponse.json(body);
    }),
  );
}

function useStreams(id: string, body: JsonBody, status = 200) {
  server.use(
    http.get(`${API}/activity/${id}/streams.json`, () =>
      status === 200 ? HttpResponse.json(body) : new HttpResponse("boom", { status }),
    ),
  );
}

describe("IntervalsIcuProvider.sync() (integration)", () => {
  let ctx: TestContext;
  const provider = new IntervalsIcuProvider();
  const run = (until = "2026-04-01T00:00:00Z") =>
    new SyncRun({
      db: ctx.db,
      window: SyncWindow.fromSince({
        since: new Date("2026-02-01T00:00:00Z"),
        until: new Date(until),
      }),
      userId: TEST_USER_ID,
      metricStreamPublisher: capture.publisher,
    });

  beforeAll(async () => {
    process.env.INTERVALS_ICU_CLIENT_ID = "client";
    process.env.INTERVALS_ICU_CLIENT_SECRET = "secret";
    ctx = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, PROVIDER_ID, "Intervals.icu", API);
    await saveTokens(ctx.db, PROVIDER_ID, {
      accessToken: "token",
      refreshToken: null,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      scopes: "ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ",
      providerAccountId: "i123",
    });
  }, 120_000);

  beforeEach(async () => {
    await ctx.db.delete(activity).where(eq(activity.providerId, PROVIDER_ID));
    capture.publishedMetricStreamRows.length = 0;
    capture.deletedMetricStreamScopes.length = 0;
  });
  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.deactivate();
    if (ctx) await ctx.cleanup();
  });

  const rows = () => ctx.db.select().from(activity).where(eq(activity.providerId, PROVIDER_ID));
  const byExternalId = async (externalId: string) =>
    (
      await ctx.db
        .select()
        .from(activity)
        .where(and(eq(activity.providerId, PROVIDER_ID), eq(activity.externalId, externalId)))
    )[0];
  const published = (channel: string) =>
    capture.publishedMetricStreamRows.filter((row) => row.channel === channel);

  /** Seed a previously imported, then tombstoned, record through a normal sync. */
  async function seedTombstoned(id: string, startDate: string) {
    useList([activityFixture(id, { start_date: startDate, stream_types: [] })]);
    await provider.sync(run("2026-05-01T00:00:00Z"));
    expect(await byExternalId(id)).toBeDefined();
    await ctx.db
      .update(activity)
      .set({ providerAbsentAt: new Date("2026-03-15T00:00:00Z"), absenceProviderId: PROVIDER_ID })
      .where(eq(activity.externalId, id));
    capture.publishedMetricStreamRows.length = 0;
  }

  it("imports a date-bounded activity with streams, incl. longitude from data2", async () => {
    let query: URL | undefined;
    useList([activityFixture("a1")], (url) => {
      query = url;
    });
    useStreams("a1", streamsFixture);

    const result = await provider.sync(run());

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(1);
    expect(query?.searchParams.get("oldest")).toBe("2026-01-31");
    expect(query?.searchParams.get("newest")).toBe("2026-04-02");
    const row = await byExternalId("a1");
    expect(row?.canonicalType).toBe("cycling");
    expect(row?.sourceName).toBe("Garmin Edge");
    expect(row?.raw).toEqual({ source: null });
    expect(row?.startedAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(row?.endedAt?.toISOString()).toBe("2026-03-01T11:00:00.000Z");
    expect(published("heart_rate").map((r) => r.scalar)).toEqual([120, 0]);
    expect(published("power")).toHaveLength(3);
    expect(published("location").map((r) => r.point)).toEqual([
      "SRID=4326;POINT(-73.1 40.1)",
      "SRID=4326;POINT(-73.2 40.2)",
      "SRID=4326;POINT(-73.3 40.3)",
    ]);
  });

  it("replays identical samples, ids, timestamps and scopes on a duplicate sync", async () => {
    useList([activityFixture("a1")]);
    useStreams("a1", streamsFixture);
    await provider.sync(run());
    const first = structuredClone(capture.publishedMetricStreamRows);
    const firstScopes = structuredClone(capture.deletedMetricStreamScopes);
    capture.publishedMetricStreamRows.length = 0;
    capture.deletedMetricStreamScopes.length = 0;

    await provider.sync(run());

    expect(await rows()).toHaveLength(1);
    expect(capture.publishedMetricStreamRows).toEqual(first);
    expect(capture.deletedMetricStreamScopes).toEqual(firstScopes);
  });

  it("keeps an in-window restricted stub's tombstoned record restored without overwriting it", async () => {
    await seedTombstoned("a1", "2026-03-01T10:00:00Z");
    useList([restrictedStub("a1")]);
    const result = await provider.sync(run());
    expect(result.errors).toEqual([]);
    const row = await byExternalId("a1");
    expect(row?.providerAbsentAt).toBeNull();
    expect(row?.name).toBe("Morning ride");
  });

  it("does not let a padded-day restricted stub restore a tombstone outside the window", async () => {
    await seedTombstoned("edge", "2026-04-01T00:00:00Z");
    useList([restrictedStub("edge")]);
    await provider.sync(run());
    expect((await byExternalId("edge"))?.providerAbsentAt).not.toBeNull();
  });

  it("includes an activity at the since edge and excludes one at the until edge", async () => {
    useList([
      activityFixture("since-edge", { start_date: "2026-02-01T00:00:00Z", stream_types: [] }),
      activityFixture("until-edge", { start_date: "2026-04-01T00:00:00Z", stream_types: [] }),
    ]);
    await provider.sync(run());
    expect((await rows()).map((row) => row.externalId)).toEqual(["since-edge"]);
  });

  it("does not let an out-of-window timestamped record restore a tombstone", async () => {
    await seedTombstoned("edge", "2026-04-01T00:00:00Z");
    useList([activityFixture("edge", { start_date: "2026-04-01T00:00:00Z" })]);
    await provider.sync(run());
    expect((await byExternalId("edge"))?.providerAbsentAt).not.toBeNull();
  });

  it("reports a failed stream fetch without losing the activity or stored channels", async () => {
    useList([activityFixture("a1")]);
    useStreams("a1", [], 500);
    const result = await provider.sync(run());
    expect(result.errors[0]?.externalId).toBe("a1");
    expect(capture.deletedMetricStreamScopes).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  it("writes valid channels when another channel is malformed and reports a degradation", async () => {
    useList([activityFixture("a1")]);
    useStreams("a1", [
      { type: "time", data: [0, 1, 2] },
      { type: "watts", data: [200, 210, 220] },
      { type: "latlng", data: [40.1, "bad", 40.3], data2: [-73.1, -73.2] },
    ]);
    const result = await provider.sync(run());
    expect(result.errors).toEqual([]);
    expect(published("power")).toHaveLength(3);
    expect(published("location")).toHaveLength(0);
    expect(capture.deletedMetricStreamScopes.map((scope) => scope.channel)).toEqual(["power"]);
    expect(result.degradations?.map((d) => d.context?.stream)).toEqual(["latlng"]);
  });

  it("clears a complete all-null channel on replay but preserves malformed or missing channels", async () => {
    useList([activityFixture("a1")]);
    useStreams("a1", streamsFixture);
    await provider.sync(run());
    capture.publishedMetricStreamRows.length = 0;
    capture.deletedMetricStreamScopes.length = 0;

    useStreams("a1", [
      { type: "time", data: [0, 1, 2] },
      { type: "heartrate", data: [null, null, null] },
      { type: "watts", data: "garbage" },
      // latlng omitted entirely
    ]);
    const result = await provider.sync(run());

    const activityId = (await byExternalId("a1"))?.id;
    expect(result.errors).toEqual([]);
    expect(capture.deletedMetricStreamScopes).toEqual([
      { userId: TEST_USER_ID, activityId, channel: "heart_rate" },
    ]);
    expect(capture.publishedMetricStreamRows).toEqual([]);
  });

  it("does not import estimated power when device_watts is false", async () => {
    useList([activityFixture("a1", { device_watts: false })]);
    useStreams("a1", streamsFixture);
    await provider.sync(run());
    expect(published("power")).toHaveLength(0);
    expect(published("heart_rate").length).toBeGreaterThan(0);
    expect(capture.deletedMetricStreamScopes.map((scope) => scope.channel)).not.toContain("power");
  });

  it("does not tombstone when a non-stub record is malformed, but keeps valid writes", async () => {
    await seedTombstoned("a1", "2026-03-01T10:00:00Z");
    await ctx.db.update(activity).set({ providerAbsentAt: null, absenceProviderId: null });
    useList([
      activityFixture("a2", { start_date: "not-a-date" }),
      activityFixture("a3", { start_date: "2026-03-02T10:00:00Z", stream_types: [] }),
    ]);
    const result = await provider.sync(run());
    expect(result.degradations?.length).toBeGreaterThan(0);
    expect((await byExternalId("a1"))?.providerAbsentAt).toBeNull();
    expect(await byExternalId("a3")).toBeDefined();
  });

  it("does not tombstone anything for malformed list data", async () => {
    await seedTombstoned("a1", "2026-03-01T10:00:00Z");
    await ctx.db.update(activity).set({ providerAbsentAt: null, absenceProviderId: null });
    useList({ not: "an array" });
    const result = await provider.sync(run());
    expect(result.errors.length).toBeGreaterThan(0);
    expect((await byExternalId("a1"))?.providerAbsentAt).toBeNull();
  });

  it("tombstones in-window activities when the authoritative list is empty", async () => {
    useList([activityFixture("a1", { stream_types: [] })]);
    await provider.sync(run());
    useList([]);
    const result = await provider.sync(run());
    expect(result.errors).toEqual([]);
    expect((await byExternalId("a1"))?.providerAbsentAt).not.toBeNull();
  });
});
