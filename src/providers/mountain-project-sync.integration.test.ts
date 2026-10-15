import { fork } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { activity } from "../db/schema/activity.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
} from "../db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import {
  createAccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "../jobs/account-erasure-work-guard.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { MountainProjectProvider } from "./mountain-project.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const fixtureCsv = readFileSync(
  join(import.meta.dirname, "fixtures/mountain-project-ticks.csv"),
  "utf8",
);
const server = setupServer();
const exportUrl = "https://www.mountainproject.com/user/110186720/ticks/tick-export";

describe("MountainProjectProvider canonical persistence", () => {
  let ctx: TestContext;
  let currentExport: string;
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(
      ctx.db,
      "mountain-project",
      "Mountain Project",
      "https://www.mountainproject.com",
      userId,
    );
    await saveTokens(
      ctx.db,
      "mountain-project",
      {
        accessToken: "110186720",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        scopes: "ticks",
      },
      userId,
    );
  });
  afterEach(async () => {
    server.resetHandlers();
    await ctx.db.delete(climbingLogEntry);
    await ctx.db.delete(climb);
    await ctx.db.update(area).set({ parentAreaId: null });
    await ctx.db.delete(area);
  });
  afterAll(async () => {
    server.close();
    await ctx.cleanup();
  });
  function run() {
    return new MountainProjectProvider().sync(
      new SyncRun({
        db: ctx.db,
        userId,
        window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")),
      }),
    );
  }
  function serve() {
    server.use(
      http.get("https://www.mountainproject.com/api/v2/routes/:id", ({ params }) =>
        HttpResponse.json({
          id: Number(params.id),
          title: "Source route",
          parent: { id: 0, name: "" },
        }),
      ),
      http.get(
        exportUrl,
        () => new HttpResponse(currentExport, { headers: { "Content-Type": "text/csv" } }),
      ),
    );
  }
  function records() {
    return ctx.db
      .select({ log: climbingLogEntry, climb })
      .from(climbingLogEntry)
      .leftJoin(climb, eq(climb.id, climbingLogEntry.climbId));
  }

  it("orders overlapping source snapshots before fetching so older metadata cannot hide newer ticks", async () => {
    const workLockPool = createAccountErasureWorkLockPool(ctx.connectionString);
    ctx.addCleanup(() => workLockPool.close());
    const [header, oldTick] = fixtureCsv.split("\n");
    if (!header || !oldTick) throw new Error("Expected a complete source tick fixture");
    const oldExport = [header, oldTick].join("\n");
    const newExport = [header, oldTick, oldTick.replace("2026-08-10", "2026-08-11")].join("\n");
    let releaseOldResponse: () => void = () => {
      throw new Error("Old response release was not initialized");
    };
    const oldResponseReleased = new Promise<void>((resolve) => {
      releaseOldResponse = resolve;
    });
    let reportOldSnapshot: () => void = () => {
      throw new Error("Old snapshot signal was not initialized");
    };
    const oldSnapshotRead = new Promise<void>((resolve) => {
      reportOldSnapshot = resolve;
    });
    let exportReads = 0;
    let areaReads = 0;
    server.use(
      http.get(exportUrl, () => new HttpResponse(++exportReads === 1 ? oldExport : newExport)),
      http.get("https://www.mountainproject.com/api/v2/routes/:id", ({ params }) =>
        HttpResponse.json({
          id: Number(params.id),
          title: "Route",
          parent: { id: 2, name: "Crag" },
        }),
      ),
      http.get("https://www.mountainproject.com/api/v2/areas/2", async () => {
        const oldSnapshot = ++areaReads === 1;
        if (oldSnapshot) {
          reportOldSnapshot();
          await oldResponseReleased;
        }
        return HttpResponse.json({
          id: 2,
          title: oldSnapshot ? "Old crag" : "Current crag",
          parent: { id: 0, name: "" },
          coordinates: oldSnapshot ? [-105, 39] : [-106, 40],
        });
      }),
    );
    const executeRefresh = (origin: string) =>
      runQueuedUserWorkUnlessAccountErasing(
        workLockPool,
        ctx.db,
        userId,
        origin,
        run,
        "mountain-project",
      );
    const oldRefresh = executeRefresh("scheduled provider sync");
    await oldSnapshotRead;
    let newerFinished = false;
    const newerRefresh = executeRefresh("manual full provider sync").finally(() => {
      newerFinished = true;
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!newerFinished) {
        const [state] = await executeWithSchema(
          ctx.db,
          z.object({ waiting: z.boolean() }),
          sql`SELECT EXISTS (
            SELECT 1 FROM pg_locks AS locks
            JOIN pg_stat_activity AS sessions ON sessions.pid = locks.pid
            WHERE locks.locktype = 'advisory' AND NOT locks.granted
              AND sessions.datname = current_database()
              AND sessions.application_name = 'dofek-account-erasure-work-lock'
          ) AS waiting`,
        );
        if (state?.waiting) {
          expect(exportReads).toBe(1);
          break;
        }
        if (Date.now() >= deadline) throw new Error("Second refresh neither waited nor finished");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      releaseOldResponse();
    }
    await expect(oldRefresh).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    await expect(newerRefresh).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await ctx.db.select().from(area)).toEqual([
      expect.objectContaining({
        externalId: "2",
        name: "Current crag",
        coordinates: { x: -106, y: 40 },
      }),
    ]);
    const stored = await records();
    expect(stored).toHaveLength(2);
    expect(stored.every(({ log }) => log.providerAbsentAt === null)).toBe(true);
    expect(stored.map(({ log }) => log.climbedOn).sort()).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it.each([
    { failure: "lock session disconnect", throughGuard: true },
    { failure: "unrelated process exit", throughGuard: false },
  ])(
    "identifies $failure during HTTP and prevents stale source writes",
    async ({ throughGuard }) => {
      const [header, oldTick] = fixtureCsv.split("\n");
      if (!header || !oldTick) throw new Error("Expected a complete source tick fixture");
      const evidenceDirectory = mkdtempSync(join(tmpdir(), "dofek-provider-lock-loss-"));
      ctx.addCleanup(async () => rmSync(evidenceDirectory, { recursive: true, force: true }));
      const evidencePath = join(evidenceDirectory, "guard-fatal.txt");
      const child = fork(new URL("../jobs/fixtures/provider-sync-lock-loss.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let diagnostics = "";
      child.stdout?.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      const signal = () => {
        let notify: () => void = () => {
          throw new Error("Child signal was not initialized");
        };
        const promise = new Promise<void>((resolve) => {
          notify = resolve;
        });
        return { promise, notify: () => notify() };
      };
      const httpPending = signal();
      const fatalCaptured = signal();
      const callbackFinished = signal();
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.on("message", (message) => {
        diagnostics += `\nIPC: ${JSON.stringify(message)}`;
        if (message === "http_pending") httpPending.notify();
        if (message === "fatal_captured") fatalCaptured.notify();
        if (message === "callback_finished") callbackFinished.notify();
      });
      child.send({
        connectionString: ctx.connectionString,
        userId,
        csv: [header, oldTick].join("\n"),
        evidencePath,
      });
      try {
        await Promise.race([
          httpPending.promise,
          exited.then((code) => {
            throw new Error(`Source fixture exited before HTTP: ${code}; ${diagnostics}`);
          }),
        ]);
        const holders = await executeWithSchema(
          ctx.db,
          z.object({ pid: z.number().int() }),
          sql`SELECT DISTINCT sessions.pid FROM pg_stat_activity AS sessions
          JOIN pg_locks AS locks ON locks.pid = sessions.pid
          WHERE sessions.datname = current_database()
            AND sessions.application_name = 'dofek-account-erasure-work-lock'
            AND locks.locktype = 'advisory' AND locks.granted`,
        );
        expect(holders).toHaveLength(1);
        const holder = holders[0];
        if (!holder) throw new Error("Expected the child source-refresh lock session");
        if (throughGuard) {
          const terminated = await executeWithSchema(
            ctx.db,
            z.object({ terminated: z.boolean() }),
            sql`SELECT pg_terminate_backend(${holder.pid}) AS terminated`,
          );
          expect(terminated).toEqual([{ terminated: true }]);
        } else {
          child.send("exit_unrelated");
        }
        await Promise.race([fatalCaptured.promise, exited]);

        currentExport = [header, oldTick, oldTick.replace("2026-08-10", "2026-08-11")].join("\n");
        serve();
        server.use(
          http.get("https://www.mountainproject.com/api/v2/routes/:id", ({ params }) =>
            HttpResponse.json({
              id: Number(params.id),
              title: "Route",
              parent: { id: 2, name: "Crag" },
            }),
          ),
          http.get("https://www.mountainproject.com/api/v2/areas/2", () =>
            HttpResponse.json({
              id: 2,
              title: "Current crag",
              parent: { id: 0, name: "" },
              coordinates: [-106, 40],
            }),
          ),
        );
        const replacementPool = createAccountErasureWorkLockPool(ctx.connectionString);
        ctx.addCleanup(() => replacementPool.close());
        await expect(
          runQueuedUserWorkUnlessAccountErasing(
            replacementPool,
            ctx.db,
            userId,
            "replacement provider sync",
            run,
            "mountain-project",
          ),
        ).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
        if (child.connected) child.send("release_http");
        const outcome = await Promise.race([
          callbackFinished.promise.then(() => ({ status: "callback_finished" as const })),
          exited.then((code) => ({ status: "exited" as const, code })),
        ]);
        const exitedThroughGuard =
          outcome.status === "exited" &&
          outcome.code === 1 &&
          existsSync(evidencePath) &&
          readFileSync(evidencePath, "utf8") === "provider_sync_session_lost\n";
        expect(exitedThroughGuard).toBe(throughGuard);
        const stored = await records();
        expect({
          outcome,
          areas: (await ctx.db.select().from(area)).map(({ name, coordinates }) => ({
            name,
            coordinates,
          })),
          activeDates: stored
            .filter(({ log }) => log.providerAbsentAt === null)
            .map(({ log }) => log.climbedOn)
            .sort(),
        }).toEqual({
          outcome: { status: "exited", code: 1 },
          areas: [{ name: "Current crag", coordinates: { x: -106, y: 40 } }],
          activeDates: ["2026-08-10", "2026-08-11"],
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        rmSync(evidenceDirectory, { recursive: true, force: true });
      }
    },
  );

  it("maps source qualifiers and current shared metadata while preserving attachment and source date", async () => {
    currentExport = fixtureCsv;
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    const before = await records();
    const west = before.find((row) => row.climb?.name === "West Overhang");
    if (!west) throw new Error("Expected West Overhang");
    expect(west.log).toMatchObject({
      activityId: null,
      climbedOn: "2026-08-10",
      notes: "placeholder note",
      discipline: "rock_climbing",
    });
    expect(west.climb).toMatchObject({ externalId: "105751342", kind: "route", setting: null });
    expect(
      await ctx.db
        .select()
        .from(climbGrade)
        .where(eq(climbGrade.climbId, west.log.climbId ?? "")),
    ).toEqual([expect.objectContaining({ system: "yds", value: "5.7", position: 0 })]);
    expect((await ctx.db.select().from(area)).map((row) => row.name)).toEqual(
      expect.arrayContaining(["Colorado", "Boulder", "Eldorado Canyon"]),
    );
    const attempts = await ctx.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, west.log.id));
    expect(attempts).toEqual([
      expect.objectContaining({
        scope: "climb",
        ropeMethod: "lead",
        outcome: "completed",
        fellOrHung: false,
        usedAid: false,
        receivedBeta: false,
        attemptIndex: 1,
      }),
    ]);
    const [parent] = await ctx.db
      .insert(activity)
      .values({
        providerId: "mountain-project",
        userId,
        externalId: "manual-parent",
        canonicalType: "climbing",
        providerType: "manual",
        startedAt: new Date("2026-08-10T00:00:00Z"),
      })
      .returning();
    if (!parent) throw new Error("Expected parent");
    await ctx.db
      .update(climbingLogEntry)
      .set({ activityId: parent.id })
      .where(eq(climbingLogEntry.id, west.log.id));
    server.use(
      http.get("https://www.mountainproject.com/api/v2/routes/105751342", () =>
        HttpResponse.json({
          id: 105751342,
          title: "West Overhang",
          parent: { id: 2, name: "Eldorado Canyon", coordinates: [-120, 35] },
          pitches: 3,
        }),
      ),
      http.get("https://www.mountainproject.com/api/v2/areas/:id", ({ params }) =>
        HttpResponse.json({
          id: Number(params.id),
          title: params.id === "2" ? "Eldorado Canyon" : "Colorado",
          parent: { id: params.id === "2" ? 1 : 0, name: "Colorado" },
          coordinates: params.id === "2" ? [-105.3, 39.9] : null,
        }),
      ),
    );
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    expect((await records()).find((row) => row.log.id === west.log.id)?.log).toMatchObject({
      activityId: parent.id,
      climbedOn: "2026-08-10",
      externalId: west.log.externalId,
      raw: expect.objectContaining({
        Route: "West Overhang",
        sourceEnrichment: expect.objectContaining({
          route: expect.objectContaining({ pitches: 3 }),
        }),
      }),
    });
    const enriched = (await records()).find((row) => row.log.id === west.log.id);
    expect(enriched?.climb).toMatchObject({ id: west.climb?.id, coordinates: null, setting: null });
    const areas = await ctx.db.select().from(area);
    const crag = areas.find((row) => row.externalId === "2");
    expect(crag).toMatchObject({
      coordinates: { x: -105.3, y: 39.9 },
      parentAreaId: areas.find((row) => row.externalId === "1")?.id,
    });
    expect(
      await ctx.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, west.log.id)),
    ).toEqual(attempts);
  });

  it("refreshes verified Area names GPS and parentage without replacing recorded identities", async () => {
    currentExport = fixtureCsv.split("\n").slice(0, 2).join("\n");
    serve();
    let refreshed = false;
    server.use(
      http.get("https://www.mountainproject.com/api/v2/routes/105751342", () =>
        HttpResponse.json({
          id: 105751342,
          title: "West Overhang",
          parent: { id: 2, name: "Crag" },
        }),
      ),
      http.get("https://www.mountainproject.com/api/v2/areas/:id", ({ params }) =>
        HttpResponse.json({
          id: Number(params.id),
          title: params.id === "2" ? (refreshed ? "Renamed crag" : "Original crag") : "Region",
          parent: { id: params.id === "2" ? (refreshed ? 3 : 1) : 0, name: "Region" },
          coordinates: params.id === "2" ? (refreshed ? [-105.4, 40] : [-105.3, 39.9]) : null,
        }),
      ),
    );
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    const [before] = await records();
    const [originalCrag] = await ctx.db.select().from(area).where(eq(area.externalId, "2"));
    const originalAttempts = await ctx.db.select().from(climbingAttempt);
    if (!before || !originalCrag) throw new Error("Expected original enriched record");
    refreshed = true;
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    const [after] = await records();
    const [newParent] = await ctx.db.select().from(area).where(eq(area.externalId, "3"));
    const [currentCrag] = await ctx.db.select().from(area).where(eq(area.externalId, "2"));
    if (!newParent) throw new Error("Expected refreshed parent Area");
    expect(currentCrag).toMatchObject({
      id: originalCrag.id,
      name: "Renamed crag",
      parentAreaId: newParent.id,
      coordinates: { x: -105.4, y: 40 },
    });
    expect(after?.log).toMatchObject({
      id: before.log.id,
      externalId: before.log.externalId,
      climbId: before.log.climbId,
    });
    expect(after?.climb).toMatchObject({
      id: before.climb?.id,
      areaId: originalCrag.id,
      coordinates: null,
    });
    expect(await ctx.db.select().from(climbingAttempt)).toEqual(originalAttempts);
  });

  it.each(["HTTP failure", "malformed ancestor"])(
    "leaves persisted metadata and absence untouched after later enrichment %s",
    async (mode) => {
      currentExport = fixtureCsv;
      serve();
      await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
      const before = await records();
      const beforeAreas = await ctx.db.select().from(area);
      currentExport = fixtureCsv
        .split("\n")
        .filter((line) => !line.includes("Jim Hall Left"))
        .join("\n")
        .replace("placeholder note", "Changed source note");
      server.use(
        http.get("https://www.mountainproject.com/api/v2/routes/110994870", () =>
          mode === "HTTP failure"
            ? new HttpResponse("unavailable", { status: 503 })
            : HttpResponse.json({
                id: 110994870,
                title: "Still My Way",
                parent: { id: 55, name: "Crag" },
              }),
        ),
        http.get("https://www.mountainproject.com/api/v2/areas/55", () =>
          HttpResponse.json({
            id: 55,
            title: "Crag",
            parent: { id: 0, name: "" },
            coordinates: [37],
          }),
        ),
      );
      await expect(run()).resolves.toMatchObject({
        recordsSynced: 0,
        errors: [expect.any(Object)],
      });
      expect(await records()).toEqual(before);
      expect(await ctx.db.select().from(area)).toEqual(beforeAreas);
    },
  );

  it("keeps repeated occurrences separate on one verified climb", async () => {
    const source = fixtureCsv.split("\n")[1];
    if (!source) throw new Error("Expected fixture tick");
    currentExport = [fixtureCsv.split("\n")[0], source, source].join("\n");
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await records();
    expect(before).toHaveLength(2);
    expect(new Set(before.map((row) => row.log.externalId)).size).toBe(2);
    expect(new Set(before.map((row) => row.log.climbId)).size).toBe(1);
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect((await records()).map((row) => row.log.id).sort()).toEqual(
      before.map((row) => row.log.id).sort(),
    );
  });

  it("reconciles full lists while preserving records after incomplete empty or failed discovery", async () => {
    currentExport = fixtureCsv;
    serve();
    await run();
    currentExport = fixtureCsv
      .split("\n")
      .filter((line) => !line.includes("Jim Hall Left"))
      .join("\n");
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect(
      (await records()).find((row) => row.climb?.name === "Jim Hall Left")?.log.providerAbsentAt,
    ).toBeInstanceOf(Date);
    currentExport = fixtureCsv;
    await run();
    expect((await records()).every((row) => row.log.providerAbsentAt === null)).toBe(true);
    const valid = fixtureCsv.split("\n")[1];
    currentExport = [
      fixtureCsv.split("\n")[0],
      valid,
      "2026-02-30,Invalid,5.9,,https://www.mountainproject.com/route/1/invalid,1,Crag,2,-1,Lead,Redpoint,Trad,,,1800",
    ].join("\n");
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [expect.any(Object)] });
    expect((await records()).every((row) => row.log.providerAbsentAt === null)).toBe(true);
    currentExport = fixtureCsv.split("\n")[0] ?? "";
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await records()).toHaveLength(3);
    server.use(http.get(exportUrl, () => new HttpResponse("unavailable", { status: 503 })));
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect((await records()).every((row) => row.log.providerAbsentAt === null)).toBe(true);
  });

  it("retains missing grade date and location without inventing rock classification", async () => {
    currentExport = [
      fixtureCsv.split("\n")[0],
      ",Unknown summit,,Source note,https://www.mountainproject.com/route/123/unknown,1,,2,-1,,,,,,0",
    ].join("\n");
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    const [record] = await records();
    expect(record?.log).toMatchObject({ climbedOn: null, discipline: null, notes: "Source note" });
    expect(record?.climb).toMatchObject({ areaId: null, setting: null });
    expect(await ctx.db.select().from(climbGrade)).toEqual([]);
    expect(await ctx.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({ attemptIndex: null, outcome: null }),
    ]);
  });
  it("persists published compound grades separately from a supplied route rating opinion", async () => {
    currentExport = [
      fixtureCsv.split("\n")[0],
      "2026-08-10,Compound,5.10 A2,,https://www.mountainproject.com/route/123/compound,3,Crag,2,-1,Aid,Flash,Trad,5.9,,3000",
    ].join("\n");
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      (await ctx.db.select().from(climbGrade)).map(({ value, system, position }) => ({
        value,
        system,
        position,
      })),
    ).toEqual([
      { value: "5.10", system: "yds", position: 0 },
      { value: "A2", system: "aid", position: 1 },
    ]);
    expect(await ctx.db.select().from(climbingLogEntryGrade)).toEqual([
      expect.objectContaining({ value: "5.9", system: "yds", position: 0 }),
    ]);
    expect(await ctx.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({
        scope: "climb",
        usedAid: true,
        fellOrHung: null,
        outcome: "completed",
        receivedBeta: true,
      }),
    ]);
  });
});
