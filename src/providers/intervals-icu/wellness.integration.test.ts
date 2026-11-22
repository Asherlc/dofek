import { and, eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runWithProviderIngestContext } from "../../db/provider-ingest-context.ts";
import { dailyMetrics } from "../../db/schema/activity.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { executeWithSchema } from "../../db/typed-sql.ts";
import { createIntegrationMswFixture } from "../../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { IntervalsIcuClient } from "./client.ts";
import { syncIntervalsIcuWellness } from "./wellness.ts";

const API = "https://intervals.icu/api/v1";
const PROVIDER_ID = "intervals.icu";
const server = createIntegrationMswFixture();

type JsonBody = Parameters<typeof HttpResponse.json>[0];

describe("syncIntervalsIcuWellness (integration)", () => {
  let ctx: TestContext;
  const client = () => new IntervalsIcuClient("token", globalThis.fetch);
  const run = (since = "2026-03-01T00:00:00Z", until = "2026-03-04T00:00:00Z") =>
    new SyncRun({
      db: ctx.db,
      window: SyncWindow.fromSince({ since: new Date(since), until: new Date(until) }),
      userId: TEST_USER_ID,
    });
  const useWellness = (body: JsonBody, onRequest?: (url: URL) => void) =>
    server.use(
      http.get(`${API}/athlete/0/wellness`, ({ request }) => {
        onRequest?.(new URL(request.url));
        return HttpResponse.json(body);
      }),
    );
  const sync = (window = run()) => syncIntervalsIcuWellness(client(), window, PROVIDER_ID);

  const parents = () =>
    ctx.db
      .select()
      .from(dailyMetrics)
      .where(and(eq(dailyMetrics.providerId, PROVIDER_ID), eq(dailyMetrics.userId, TEST_USER_ID)))
      .orderBy(dailyMetrics.date);
  const catalog = async () =>
    executeWithSchema(
      ctx.db,
      z.object({ date: z.string(), metric_type_id: z.string(), value: z.number() }),
      sql`SELECT dm.date::text AS date, v.metric_type_id, v.value
          FROM fitness.daily_metric_value v
          JOIN fitness.daily_metrics dm ON dm.id = v.daily_metrics_id
          WHERE dm.provider_id = ${PROVIDER_ID} AND dm.user_id = ${TEST_USER_ID}
          ORDER BY dm.date, v.metric_type_id`,
    );

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, PROVIDER_ID, "Intervals.icu", API);
  }, 120_000);
  beforeEach(async () => {
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, PROVIDER_ID));
  });
  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.deactivate();
    if (ctx) await ctx.cleanup();
  });

  const full = {
    id: "2026-03-01",
    weight: 70.5,
    restingHR: 52,
    hrv: 61.2,
    steps: 0,
    sleepSecs: 27000,
    spO2: 97.5,
  };

  it("requires a user ID before requesting any source data", async () => {
    const missingUser = new SyncRun({
      db: ctx.db,
      window: SyncWindow.fromSince({
        since: new Date("2026-03-01T00:00:00Z"),
        until: new Date("2026-03-04T00:00:00Z"),
      }),
    });

    await expect(sync(missingUser)).rejects.toThrow(/requires a user ID/);
  });

  it("requests inclusive local dates without a fields projection and stores source facts", async () => {
    let query: URL | undefined;
    useWellness([full], (url) => {
      query = url;
    });

    const result = await sync();

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(1);
    expect(query?.searchParams.get("oldest")).toBe("2026-03-01");
    expect(query?.searchParams.get("newest")).toBe("2026-03-04");
    expect(query?.searchParams.has("fields")).toBe(false);
    expect(await parents()).toEqual([
      expect.objectContaining({
        date: "2026-03-01",
        sourceName: null,
        hrv: 61.2,
        steps: 0,
        spo2Avg: 97.5,
      }),
    ]);
    expect(await catalog()).toEqual([
      { date: "2026-03-01", metric_type_id: "resting_heart_rate", value: 52 },
      { date: "2026-03-01", metric_type_id: "sleep_duration_reported", value: 27000 },
      { date: "2026-03-01", metric_type_id: "weight", value: 70.5 },
    ]);
  });

  it("uses athlete-local date bounds for relative windows at a UTC day boundary", async () => {
    // 02:00Z on 2026-03-01 is still 2026-02-28 in the athlete's home timezone.
    const requestedAt = new Date("2026-03-01T02:00:00.000Z");
    let query: URL | undefined;
    useWellness([], (url) => {
      query = url;
    });
    const relative = new SyncRun({
      db: ctx.db,
      window: SyncWindow.lastDays(3, { now: requestedAt }),
      userId: TEST_USER_ID,
      requestedAt,
      relativeWindow: true,
    });

    await runWithProviderIngestContext({ homeTimezone: "America/Los_Angeles" }, () =>
      sync(relative),
    );

    expect(query?.searchParams.get("oldest")).toBe("2026-02-25");
    expect(query?.searchParams.get("newest")).toBe("2026-02-28");
  });

  it("preserves explicit date labels as-is in a non-UTC home timezone", async () => {
    let query: URL | undefined;
    useWellness([], (url) => {
      query = url;
    });
    const explicit = new SyncRun({
      db: ctx.db,
      window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-04" }),
      userId: TEST_USER_ID,
    });

    await runWithProviderIngestContext({ homeTimezone: "America/Los_Angeles" }, () =>
      sync(explicit),
    );

    expect(query?.searchParams.get("oldest")).toBe("2026-03-01");
    expect(query?.searchParams.get("newest")).toBe("2026-03-04");
  });

  it("ignores vendor days outside the exact requested range, even with null clears", async () => {
    useWellness([full]);
    await sync();
    useWellness([
      { id: "2026-02-28", steps: 5 },
      { id: "2026-03-05", steps: 6 },
      { id: "2026-03-01", weight: 70.5 },
    ]);
    await sync(run("2026-03-02T00:00:00Z", "2026-03-04T00:00:00Z"));

    expect((await parents()).map((row) => [row.date, row.steps])).toEqual([["2026-03-01", 0]]);
    expect(await catalog()).toHaveLength(3);
  });

  it("replays idempotently across overlapping windows", async () => {
    useWellness([full]);
    await sync();
    await sync(run("2026-02-28T00:00:00Z", "2026-03-02T00:00:00Z"));

    expect(await parents()).toHaveLength(1);
    expect(await catalog()).toHaveLength(3);
  });

  it("clears on explicit null and preserves omitted fields", async () => {
    useWellness([full]);
    await sync();
    useWellness([{ id: "2026-03-01", weight: null, hrv: null }]);
    await sync();

    const [row] = await parents();
    expect(row).toEqual(expect.objectContaining({ hrv: null, steps: 0, spo2Avg: 97.5 }));
    expect((await catalog()).map((entry) => entry.metric_type_id)).toEqual([
      "resting_heart_rate",
      "sleep_duration_reported",
    ]);
  });

  it("does not let temporary defaults overwrite or clear measured facts, on replay too", async () => {
    useWellness([full]);
    await sync();
    const temporary = [
      { id: "2026-03-01", weight: 80, tempWeight: true, tempRestingHR: true },
      {
        id: "2026-03-02",
        weight: 81,
        tempWeight: true,
        restingHR: 61,
        tempRestingHR: true,
        steps: 100,
      },
    ];
    useWellness(temporary);
    await sync();
    await sync();

    expect(await catalog()).toEqual([
      { date: "2026-03-01", metric_type_id: "resting_heart_rate", value: 52 },
      { date: "2026-03-01", metric_type_id: "sleep_duration_reported", value: 27000 },
      { date: "2026-03-01", metric_type_id: "weight", value: 70.5 },
    ]);
    expect((await parents()).map((row) => [row.date, row.steps])).toEqual([
      ["2026-03-01", 0],
      ["2026-03-02", 100],
    ]);

    useWellness([{ id: "2026-03-01", weight: null, tempWeight: true }]);
    await sync();
    expect((await catalog()).map((entry) => entry.metric_type_id)).not.toContain("weight");
  });

  it("keeps legitimate zero steps and sleep, and reports other zero measurements as malformed", async () => {
    useWellness([{ id: "2026-03-01", steps: 0, sleepSecs: 0 }]);
    await sync();
    expect(await catalog()).toEqual([
      { date: "2026-03-01", metric_type_id: "sleep_duration_reported", value: 0 },
    ]);

    useWellness([{ id: "2026-03-01", weight: 0, hrv: 0 }]);
    const result = await sync();

    expect(result.errors).toHaveLength(1);
    expect(result.recordsSynced).toBe(0);
    expect((await parents())[0]).toEqual(expect.objectContaining({ steps: 0, hrv: null }));
    expect(await catalog()).toHaveLength(1);
  });

  it.each([
    ["negative steps", { steps: -1 }],
    ["fractional steps", { steps: 10.5 }],
    ["oversized steps", { steps: 2_147_483_648 }],
    ["fractional resting heart rate", { restingHR: 50.5 }],
    ["fractional sleep seconds", { sleepSecs: 10.5 }],
    ["percent above 100", { spO2: 101 }],
  ])("reports %s without writing or clearing the day", async (_name, patch) => {
    useWellness([full]);
    await sync();
    useWellness([
      { id: "2026-03-01", ...patch },
      { id: "2026-03-02", steps: 7 },
    ]);

    const result = await sync();

    expect(result.errors).toHaveLength(1);
    expect(result.recordsSynced).toBe(1);
    expect((await parents()).map((row) => [row.date, row.steps])).toEqual([
      ["2026-03-01", 0],
      ["2026-03-02", 7],
    ]);
    expect(await catalog()).toHaveLength(3);
  });

  it("reports a malformed id without discarding valid days", async () => {
    useWellness([
      { id: "not-a-date", steps: 5 },
      { id: "2026-03-02", steps: 7 },
    ]);

    const result = await sync();

    expect(result.errors).toHaveLength(1);
    expect(result.recordsSynced).toBe(1);
    expect((await parents()).map((row) => row.date)).toEqual(["2026-03-02"]);
  });

  it("creates no placeholder parent for omitted, temporary-only or null-only days", async () => {
    useWellness([
      { id: "2026-03-01" },
      { id: "2026-03-02", weight: 80, tempWeight: true },
      { id: "2026-03-03", weight: null, steps: null },
    ]);

    const result = await sync();

    expect(result.errors).toEqual([]);
    expect(await parents()).toEqual([]);
  });

  it("stops before writing when the sync is cancelled", async () => {
    useWellness([full]);
    const controller = new AbortController();
    controller.abort();
    const cancelled = new SyncRun({
      db: ctx.db,
      window: SyncWindow.fromSince({
        since: new Date("2026-03-01T00:00:00Z"),
        until: new Date("2026-03-04T00:00:00Z"),
      }),
      userId: TEST_USER_ID,
      signal: controller.signal,
    });

    const result = await sync(cancelled);

    expect(result.errors).toHaveLength(1);
    expect(await parents()).toEqual([]);
  });
});
