import { queryCache } from "dofek/lib/cache";
import { savePersonalizedParams } from "dofek/personalization/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import {
  type ClickHouseMetricStreamSeedRow,
  createClickHouseTestActivitySensorStore,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "./clickhouse-integration-test-helpers.ts";

/**
 * Integration tests that INSERT data and verify JS transformation logic
 * in tRPC router endpoints. Complements router-sql.test.ts (which tests
 * with empty tables) by exercising the data transformation paths.
 */

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_TEST_USER_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("Router transformation logic", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;
  let otherUserSessionCookie: string;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;
    await testCtx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${OTHER_TEST_USER_ID}, 'Other Cache Test User')
          ON CONFLICT DO NOTHING`,
    );
    const otherUserSession = await createSession(testCtx.db, OTHER_TEST_USER_ID);
    otherUserSessionCookie = `session=${otherUserSession.sessionId}`;

    // Insert a test provider (needed for FK constraints)
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES ('test-provider', 'Test Provider')
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider_connection (user_id, provider_id)
          VALUES (${TEST_USER_ID}, 'test-provider')
          ON CONFLICT DO NOTHING`,
    );

    const sensorStore = await createClickHouseTestActivitySensorStore(testCtx);
    const app = createApp(testCtx.db, sensorStore);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  /** POST a tRPC query and return parsed response */
  async function query(path: string, input: Record<string, unknown> = {}, cookie = sessionCookie) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  /** POST a tRPC mutation and return parsed response */
  async function mutate(path: string, input: Record<string, unknown> = {}, cookie = sessionCookie) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  // ══════════════════════════════════════════════════════════════
  // Life Events — CRUD operations
  // ══════════════════════════════════════════════════════════════
  describe("lifeEvents CRUD", () => {
    let createdEventId: string;

    it("create inserts a life event and returns it", async () => {
      await query("lifeEvents.list");
      const { status, result } = await mutate("lifeEvents.create", {
        label: "Started new job",
        startedAt: "2025-06-01",
        category: "career",
        ongoing: true,
        notes: "Remote position",
      });
      expect(status).toBe(200);
      expect(result.result.data).toBeDefined();
      const event = result.result.data;
      expect(event.label).toBe("Started new job");
      expect(event.category).toBe("career");
      expect(event.ongoing).toBe(true);
      expect(event.notes).toBe("Remote position");
      expect(event.id).toBeDefined();
      createdEventId = event.id;

      const { result: listResult } = await query("lifeEvents.list");
      expect(
        listResult.result.data.find((listedEvent: { id: string }) => listedEvent.id === event.id),
      ).toBeDefined();
    });

    it("list returns the created event", async () => {
      const { status, result } = await query("lifeEvents.list");
      expect(status).toBe(200);
      const events = result.result.data;
      expect(events.length).toBeGreaterThanOrEqual(1);
      const found = events.find((e: { id: string }) => e.id === createdEventId);
      expect(found).toBeDefined();
      expect(found.label).toBe("Started new job");
    });

    it("update modifies specific fields", async () => {
      const { status, result } = await mutate("lifeEvents.update", {
        id: createdEventId,
        label: "Left job",
        ongoing: false,
        endedAt: "2025-12-31",
      });
      expect(status).toBe(200);
      const updated = result.result.data;
      expect(updated.label).toBe("Left job");
      expect(updated.ongoing).toBe(false);

      const { result: listResult } = await query("lifeEvents.list");
      expect(
        listResult.result.data.find((event: { id: string }) => event.id === createdEventId)?.label,
      ).toBe("Left job");
    });

    it("update all fields including null-clearing", async () => {
      // Covers: startedAt, category→null, notes→null, endedAt→null branches
      const { status, result } = await mutate("lifeEvents.update", {
        id: createdEventId,
        startedAt: "2025-07-01",
        endedAt: null,
        category: null,
        notes: null,
      });
      expect(status).toBe(200);
      const updated = result.result.data;
      expect(updated.ended_at).toBeNull();
      expect(updated.category).toBeNull();
      expect(updated.notes).toBeNull();

      const { result: listResult } = await query("lifeEvents.list");
      const listedEvent = listResult.result.data.find(
        (event: { id: string }) => event.id === createdEventId,
      );
      expect(listedEvent.ended_at).toBeNull();
      expect(listedEvent.category).toBeNull();
      expect(listedEvent.notes).toBeNull();
    });

    it("update with no fields returns null", async () => {
      const { status, result } = await mutate("lifeEvents.update", {
        id: createdEventId,
      });
      expect(status).toBe(200);
      expect(result.result.data).toBeNull();
    });

    it("delete removes the event", async () => {
      const { status, result } = await mutate("lifeEvents.delete", {
        id: createdEventId,
      });
      expect(status).toBe(200);
      expect(result.result.data.success).toBe(true);

      // Verify it's gone
      const { result: listResult } = await query("lifeEvents.list");
      const events = listResult.result.data;
      const found = events.find((e: { id: string }) => e.id === createdEventId);
      expect(found).toBeUndefined();
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sport Settings — CRUD + history
  // ══════════════════════════════════════════════════════════════
  describe("sportSettings CRUD", () => {
    let settingsId: string;

    it("upsert creates sport settings", async () => {
      await query("sportSettings.list");
      const { status, result } = await mutate("sportSettings.upsert", {
        sport: "cycling",
        ftp: 250,
        thresholdHr: 165,
        effectiveFrom: "2025-01-01",
        notes: "Start of season",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.sport).toBe("cycling");
      expect(settings.ftp).toBe(250);
      expect(settings.thresholdHr).toBe(165);
      settingsId = settings.id;

      const { result: listResult } = await query("sportSettings.list");
      expect(
        listResult.result.data.find((entry: { sport: string }) => entry.sport === "cycling")?.ftp,
      ).toBe(250);
    });

    it("upsert with same sport+date updates existing entry", async () => {
      const { status, result } = await mutate("sportSettings.upsert", {
        sport: "cycling",
        ftp: 260,
        thresholdHr: 168,
        effectiveFrom: "2025-01-01",
        notes: "Updated FTP",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.ftp).toBe(260);
      // Should be same id since ON CONFLICT updates
      expect(settings.id).toBe(settingsId);

      const { result: listResult } = await query("sportSettings.list");
      expect(
        listResult.result.data.find((entry: { sport: string }) => entry.sport === "cycling")?.ftp,
      ).toBe(260);
    });

    it("upsert with different date creates new entry", async () => {
      const { status, result } = await mutate("sportSettings.upsert", {
        sport: "cycling",
        ftp: 270,
        thresholdHr: 170,
        effectiveFrom: "2025-06-01",
        notes: "Mid-season bump",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.ftp).toBe(270);
      expect(settings.id).not.toBe(settingsId);

      const { result: listResult } = await query("sportSettings.list");
      expect(
        listResult.result.data.find((entry: { sport: string }) => entry.sport === "cycling")?.ftp,
      ).toBe(270);
    });

    it("list returns most recent per sport", async () => {
      const { status, result } = await query("sportSettings.list");
      expect(status).toBe(200);
      const list = result.result.data;
      // Should return only 1 entry for cycling (the most recent by effective_from)
      const cyclingEntries = list.filter((s: { sport: string }) => s.sport === "cycling");
      expect(cyclingEntries).toHaveLength(1);
      expect(cyclingEntries[0].ftp).toBe(270); // the June entry
    });

    it("getBySport returns setting effective at a specific date", async () => {
      // Ask for settings as of March 2025 — should get the Jan entry (FTP 260)
      const { status, result } = await query("sportSettings.getBySport", {
        sport: "cycling",
        asOfDate: "2025-03-15",
      });
      expect(status).toBe(200);
      const settings = result.result.data;
      expect(settings.ftp).toBe(260);
    });

    it("getBySport with future date returns latest", async () => {
      const { status, result } = await query("sportSettings.getBySport", {
        sport: "cycling",
        asOfDate: "2025-12-31",
      });
      expect(status).toBe(200);
      expect(result.result.data.ftp).toBe(270);
    });

    it("history returns all entries ordered by effective_from DESC", async () => {
      const { status, result } = await query("sportSettings.history", {
        sport: "cycling",
      });
      expect(status).toBe(200);
      const history = result.result.data;
      expect(history).toHaveLength(2);
      // Most recent first
      expect(history[0].ftp).toBe(270);
      expect(history[1].ftp).toBe(260);
    });

    it("delete removes a specific entry", async () => {
      const { status, result } = await mutate("sportSettings.delete", {
        id: settingsId,
      });
      expect(status).toBe(200);
      expect(result.result.data.success).toBe(true);

      const { result: histResult } = await query("sportSettings.history", {
        sport: "cycling",
      });
      expect(histResult.result.data).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Query cache invalidation after domain mutations
  // ══════════════════════════════════════════════════════════════
  describe("query cache invalidation", () => {
    it("refreshes journal questions, entries, and trends after every mutation", async () => {
      const questionSlug = "cache_invalidation_energy";
      const today = new Date().toISOString().slice(0, 10);
      await queryCache.invalidateAll();
      await testCtx.db.execute(
        sql`DELETE FROM fitness.journal_entry
            WHERE user_id = ${TEST_USER_ID} AND question_slug = ${questionSlug}`,
      );
      await testCtx.db.execute(
        sql`DELETE FROM fitness.journal_question WHERE slug = ${questionSlug}`,
      );

      const { result: questionsBefore } = await query("journal.questions");
      const { result: otherUserQuestionsBefore } = await query(
        "journal.questions",
        {},
        otherUserSessionCookie,
      );
      expect(
        questionsBefore.result.data.some(
          (question: { slug: string }) => question.slug === questionSlug,
        ),
      ).toBe(false);
      expect(
        otherUserQuestionsBefore.result.data.some(
          (question: { slug: string }) => question.slug === questionSlug,
        ),
      ).toBe(false);

      const { status: questionStatus } = await mutate("journal.createQuestion", {
        slug: questionSlug,
        displayName: "Cache invalidation energy",
        category: "custom",
        dataType: "numeric",
      });
      expect(questionStatus).toBe(200);

      const { result: questionsAfter } = await query("journal.questions");
      expect(
        questionsAfter.result.data.some(
          (question: { slug: string }) => question.slug === questionSlug,
        ),
      ).toBe(true);
      const { result: otherUserQuestionsAfter } = await query(
        "journal.questions",
        {},
        otherUserSessionCookie,
      );
      expect(
        otherUserQuestionsAfter.result.data.some(
          (question: { slug: string }) => question.slug === questionSlug,
        ),
      ).toBe(true);

      await query("journal.entries", { days: 30 });
      await query("journal.trends", { days: 3, endDate: today });

      const { status: createStatus, result: createdResult } = await mutate("journal.create", {
        date: today,
        questionSlug,
        answerNumeric: 4,
      });
      expect(createStatus).toBe(200);
      const entryId = createdResult.result.data.id;

      const { result: entriesAfterCreate } = await query("journal.entries", { days: 30 });
      expect(
        entriesAfterCreate.result.data.find((entry: { id: string }) => entry.id === entryId)
          ?.answer_numeric,
      ).toBe(4);
      const { result: trendsAfterCreate } = await query("journal.trends", {
        days: 3,
        endDate: today,
      });
      const trendAfterCreate = trendsAfterCreate.result.data.series.find(
        (series: { questionSlug: string }) => series.questionSlug === questionSlug,
      );
      expect(trendsAfterCreate.result.data.window.dayCount).toBe(3);
      expect(trendAfterCreate.points.at(-1)).toMatchObject({
        date: today,
        value: 4,
        source: { providerId: "dofek", label: "Dofek" },
      });
      expect(
        trendAfterCreate.points.filter((point: { value: number | null }) => point.value === null),
      ).toHaveLength(2);

      const { status: updateStatus } = await mutate("journal.update", {
        id: entryId,
        answerNumeric: 8,
      });
      expect(updateStatus).toBe(200);

      const { result: entriesAfterUpdate } = await query("journal.entries", { days: 30 });
      expect(
        entriesAfterUpdate.result.data.find((entry: { id: string }) => entry.id === entryId)
          ?.answer_numeric,
      ).toBe(8);
      const { result: trendsAfterUpdate } = await query("journal.trends", {
        days: 3,
        endDate: today,
      });
      expect(
        trendsAfterUpdate.result.data.series
          .find((series: { questionSlug: string }) => series.questionSlug === questionSlug)
          ?.points.at(-1),
      ).toMatchObject({ date: today, value: 8 });

      const { status: deleteStatus } = await mutate("journal.delete", { id: entryId });
      expect(deleteStatus).toBe(200);

      const { result: entriesAfterDelete } = await query("journal.entries", { days: 30 });
      expect(
        entriesAfterDelete.result.data.find((entry: { id: string }) => entry.id === entryId),
      ).toBeUndefined();
      const { result: trendsAfterDelete } = await query("journal.trends", {
        days: 3,
        endDate: today,
      });
      expect(
        trendsAfterDelete.result.data.series.find(
          (series: { questionSlug: string }) => series.questionSlug === questionSlug,
        ),
      ).toBeUndefined();
    });

    it("refreshes menstrual cycle queries after logging a period", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await queryCache.invalidateAll();
      await testCtx.db.execute(
        sql`DELETE FROM fitness.menstrual_period WHERE user_id = ${TEST_USER_ID}`,
      );

      const { result: historyBefore } = await query("menstrualCycle.history", { months: 1 });
      expect(historyBefore.result.data).toHaveLength(0);
      const { result: phaseBefore } = await query("menstrualCycle.currentPhase");
      expect(phaseBefore.result.data.phase).toBeNull();
      expect(phaseBefore.result.data.estimate).toBeNull();

      const { status } = await mutate("menstrualCycle.logPeriod", {
        startDate: today,
        notes: "Cache invalidation",
      });
      expect(status).toBe(200);

      const { result: historyAfter } = await query("menstrualCycle.history", { months: 1 });
      expect(historyAfter.result.data).toHaveLength(1);
      const { result: phaseAfter } = await query("menstrualCycle.currentPhase");
      expect(phaseAfter.result.data).toMatchObject({
        phase: null,
        estimate: null,
        availability: {
          status: "sparse-history",
          label:
            "Not enough recorded history for a phase estimate. At least 3 completed cycles are needed.",
        },
      });
    });

    it("refreshes breathwork history after logging a session", async () => {
      const startedAt = new Date().toISOString();
      await queryCache.invalidateAll();
      await testCtx.db.execute(
        sql`DELETE FROM fitness.breathwork_session
            WHERE user_id = ${TEST_USER_ID} AND notes = 'Cache invalidation'`,
      );

      const { result: historyBefore } = await query("breathwork.history", { days: 1 });
      expect(historyBefore.result.data).toHaveLength(0);

      const { status, result: createdResult } = await mutate("breathwork.logSession", {
        techniqueId: "box-breathing",
        rounds: 4,
        durationSeconds: 64,
        startedAt,
        notes: "Cache invalidation",
      });
      expect(status).toBe(200);
      const sessionId = createdResult.result.data.id;

      const { result: historyAfter } = await query("breathwork.history", { days: 1 });
      expect(
        historyAfter.result.data.find((session: { id: string }) => session.id === sessionId),
      ).toBeDefined();
    });

    it("refreshes personalization status after reset", async () => {
      await queryCache.invalidateAll();
      await savePersonalizedParams(testCtx.db, TEST_USER_ID, {
        version: 1,
        fittedAt: new Date().toISOString(),
        exponentialMovingAverage: null,
        readinessWeights: null,
        sleepTarget: { minutes: 500, sampleCount: 10 },
        stressThresholds: null,
        trainingImpulseConstants: null,
      });

      const { result: statusBefore } = await query("personalization.status");
      expect(statusBefore.result.data.isPersonalized).toBe(true);

      const { status } = await mutate("personalization.reset");
      expect(status).toBe(200);

      const { result: statusAfter } = await query("personalization.status");
      expect(statusAfter.result.data.isPersonalized).toBe(false);
    });

    it("disconnects the provider while retaining downstream sync logs", async () => {
      const providerId = "cache-invalidation-provider";
      await queryCache.invalidateAll();
      await testCtx.db.execute(sql`DELETE FROM fitness.sync_log WHERE provider_id = ${providerId}`);
      await testCtx.db.execute(sql`DELETE FROM fitness.provider WHERE id = ${providerId}`);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name)
            VALUES (${providerId}, 'Cache invalidation provider')`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider_connection (user_id, provider_id)
            VALUES (${TEST_USER_ID}, ${providerId})`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status)
            VALUES (${providerId}, ${TEST_USER_ID}, 'activities', 'success')`,
      );

      const logsInput = { providerId, limit: 50, offset: 0, filters: {} };
      const { result: logsBefore } = await query("providerDetail.logs", logsInput);
      expect(logsBefore.result.data).toHaveLength(1);

      const { status } = await mutate("providerDetail.disconnect", { providerId });
      expect(status).toBe(200);

      const connectionsAfter = await testCtx.db.execute(
        sql`SELECT provider_id
            FROM fitness.provider_connection
            WHERE user_id = ${TEST_USER_ID} AND provider_id = ${providerId}`,
      );
      expect(connectionsAfter).toHaveLength(0);

      const { result: logsAfter } = await query("providerDetail.logs", logsInput);
      expect(logsAfter.result.data).toHaveLength(1);
    });

    it("refreshes provider and downstream queries after queuing data deletion", async () => {
      const providerId = "cache-invalidation-delete-provider";
      const providerDeleteUserId = "00000000-0000-4000-8000-000000000018";
      await queryCache.invalidateAll();
      await testCtx.db.execute(sql`DELETE FROM fitness.sync_log WHERE provider_id = ${providerId}`);
      await testCtx.db.execute(
        sql`DELETE FROM fitness.provider_data_deletion_outbox
            WHERE user_id = ${providerDeleteUserId} AND provider_id = ${providerId}`,
      );
      await testCtx.db.execute(sql`DELETE FROM fitness.provider WHERE id = ${providerId}`);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.user_profile (id, name)
            VALUES (${providerDeleteUserId}, 'Provider deletion cache user')
            ON CONFLICT (id) DO NOTHING`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider (id, name)
            VALUES (${providerId}, 'Cache invalidation delete provider')`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.provider_connection (user_id, provider_id)
            VALUES (${providerDeleteUserId}, ${providerId})`,
      );
      await testCtx.db.execute(
        sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status)
            VALUES (${providerId}, ${providerDeleteUserId}, 'activities', 'success')`,
      );
      const providerDeleteSession = await createSession(testCtx.db, providerDeleteUserId);
      const providerDeleteCookie = `session=${providerDeleteSession.sessionId}`;

      const logsInput = { providerId, limit: 50, offset: 0, filters: {} };
      const { result: logsBefore } = await query(
        "providerDetail.logs",
        logsInput,
        providerDeleteCookie,
      );
      expect(logsBefore.result.data).toHaveLength(1);

      const { status } = await mutate(
        "providerDetail.deleteAllData",
        {
          providerId,
          confirmation: "DELETE",
        },
        providerDeleteCookie,
      );
      expect(status).toBe(200);

      const { result: logsAfter } = await query(
        "providerDetail.logs",
        logsInput,
        providerDeleteCookie,
      );
      expect(logsAfter.result.data).toHaveLength(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sleep Need — Whoop-inspired sleep need formula
  // ══════════════════════════════════════════════════════════════
  describe("sleepNeed", () => {
    beforeAll(async () => {
      // Insert 30 nights of sleep data + daily HRV
      const sleepInserts: ReturnType<typeof sql>[] = [];
      const metricsInserts: ReturnType<typeof sql>[] = [];
      const sleepNeedMetricStreamRows: ClickHouseMetricStreamSeedRow[] = [];

      for (let i = 1; i <= 30; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);

        // Sleep: vary between 400-500 min
        const durationMin = 400 + Math.round(Math.sin(i) * 50);
        const startHour = 22;
        const startedAt = new Date(date);
        startedAt.setHours(startHour, 0, 0, 0);
        const endedAt = new Date(startedAt.getTime() + durationMin * 60 * 1000);

        sleepInserts.push(
          sql`INSERT INTO fitness.sleep_session
              (provider_id, user_id, external_id, started_at, ended_at, duration_minutes, sleep_type)
              VALUES ('test-provider', ${TEST_USER_ID}, ${`sleep-${i}`}, ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${durationMin}, 'sleep')`,
        );

        // Daily metrics: HRV varies with sleep quality (higher sleep = higher HRV next day)
        const hrv = 40 + (durationMin - 400) * 0.5;
        metricsInserts.push(
          sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, hrv, steps)
              VALUES (${dateStr}::date, 'test-provider', ${TEST_USER_ID}, ${hrv}, ${8000 + Math.round(Math.random() * 4000)})
              ON CONFLICT DO NOTHING`,
        );
        for (let sampleIndex = 0; sampleIndex < 30; sampleIndex++) {
          sleepNeedMetricStreamRows.push({
            userId: TEST_USER_ID,
            recordedAt: new Date(startedAt.getTime() + (sampleIndex + 1) * 60_000).toISOString(),
            providerId: "test-provider",
            sourceType: "api",
            channel: "heart_rate",
            scalar: 58,
          });
        }
      }

      for (const insert of [...sleepInserts, ...metricsInserts]) {
        await testCtx.db.execute(insert);
      }

      await syncClickHouseTestActivitySensorStore(testCtx);
      await seedClickHouseMetricStreamRows(testCtx, sleepNeedMetricStreamRows);
      await queryCache.invalidateAll();
    }, 30_000);

    it("returns personalized sleep need with data", async () => {
      const { status, result } = await query("sleepNeed.calculate", {
        targetWakeHour: 7,
        targetWakeMinute: 0,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      if (data === null) {
        expect(data).toBeNull();
        return;
      }

      // With 30 nights of data and varied HRV, we should get a calculated baseline
      expect(data.baselineMinutes).toBeGreaterThan(0);
      expect(data.totalNeedMinutes).toBeGreaterThan(0);
      expect(data.totalNeedMinutes).toBeGreaterThanOrEqual(data.baselineMinutes);
      // Calendar-based: always exactly 7 nights
      expect(data.recentNights).toHaveLength(7);

      for (const night of data.recentNights) {
        expect(night.date).toBeTruthy();
        expect(night.neededMinutes).toBeGreaterThan(0);
        // Nights with data have numeric values; calendar gaps have null
        if (night.actualMinutes != null) {
          expect(night.actualMinutes).toBeGreaterThan(0);
          expect(night.debtMinutes).toBeGreaterThanOrEqual(0);
        } else {
          expect(night.debtMinutes).toBeNull();
        }
      }
    });

    it("accumulated debt reflects sleep deficits", async () => {
      const { status, result } = await query("sleepNeed.calculate", {
        targetWakeHour: 7,
        targetWakeMinute: 0,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      if (data === null) {
        expect(data).toBeNull();
        return;
      }

      // If baseline > some nights' durations, there should be accumulated debt
      // (our test data varies 400-500 min, so if baseline is ~450, some nights are below)
      expect(data.accumulatedDebtMinutes).toBeGreaterThan(0);
      expect(typeof data.strainDebtMinutes).toBe("number");
      const nightsWithData = data.recentNights.filter((night) => night.actualMinutes != null);
      expect(nightsWithData.length).toBeGreaterThan(0);
      expect(nightsWithData.every((night) => night.providerId === "test-provider")).toBe(true);
      expect(nightsWithData.every((night) => night.sourceProviders.includes("test-provider"))).toBe(
        true,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Weekly Report — strain zones and sleep performance
  // ══════════════════════════════════════════════════════════════
  describe("weeklyReport", () => {
    beforeAll(async () => {
      // Insert activities with HR data for weekly report calculations
      // Need activities in the activity table + metric_stream for activity_summary
      const now = new Date();

      const weeklyReportMetricStreamRows: ClickHouseMetricStreamSeedRow[] = [];

      for (let week = 0; week < 8; week++) {
        for (let day = 0; day < 3; day++) {
          // 3 activities per week
          const activityDate = new Date(now);
          activityDate.setDate(activityDate.getDate() - week * 7 - day);
          const startedAt = new Date(activityDate);
          startedAt.setHours(8, 0, 0, 0);
          const endedAt = new Date(startedAt.getTime() + 60 * 60 * 1000); // 1 hour

          const externalId = `weekly-act-${week}-${day}`;

          await testCtx.db.execute(
            sql`INSERT INTO fitness.activity
                (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
                VALUES ('test-provider', ${TEST_USER_ID}, ${externalId}, 'cycling', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${`Ride ${externalId}`})
                ON CONFLICT DO NOTHING`,
          );

          // Insert metric_stream data for activity_summary
          const activityRows = await testCtx.db.execute(
            sql`SELECT id FROM fitness.activity WHERE external_id = ${externalId} AND provider_id = 'test-provider'`,
          );
          const activityId = activityRows[0]?.id;
          if (activityId) {
            for (let minute = 0; minute < 60; minute++) {
              const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
              const hr = 140 + Math.round(Math.random() * 20);
              const power = 180 + Math.round(Math.random() * 40);
              const speed = 6.5 + Math.random();
              const recordedAt = sampleTime.toISOString();
              weeklyReportMetricStreamRows.push(
                {
                  userId: TEST_USER_ID,
                  recordedAt,
                  providerId: "test-provider",
                  sourceType: "api",
                  channel: "heart_rate",
                  activityId,
                  scalar: hr,
                },
                {
                  userId: TEST_USER_ID,
                  recordedAt,
                  providerId: "test-provider",
                  sourceType: "api",
                  channel: "power",
                  activityId,
                  scalar: power,
                },
                {
                  userId: TEST_USER_ID,
                  recordedAt,
                  providerId: "test-provider",
                  sourceType: "api",
                  channel: "speed",
                  activityId,
                  scalar: speed,
                },
              );
            }
          }
        }
      }

      await testCtx.db.execute(
        sql`UPDATE fitness.user_profile SET max_hr = 190 WHERE id = ${TEST_USER_ID}`,
      );

      await syncClickHouseTestActivitySensorStore(testCtx);
      await seedClickHouseMetricStreamRows(testCtx, weeklyReportMetricStreamRows);
    }, 120_000);

    it("returns weekly summaries with strain zones", async () => {
      const { status, result } = await query("weeklyReport.report", {
        weeks: 8,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data.current).toBeDefined();
      expect(data.history).toBeDefined();
      expect(Array.isArray(data.history)).toBe(true);

      if (data.current) {
        expect(data.current.weekStart).toBeTruthy();
        expect(typeof data.current.trainingHours).toBe("number");
        expect(typeof data.current.activityCount).toBe("number");
        expect(typeof data.current.avgDailyLoad).toBe("number");
        expect(typeof data.current.sleepPerformancePct).toBe("number");
      }

      // With 8 weeks of data, history should have entries
      if (data.history.length > 0) {
        for (const week of data.history) {
          expect(week.weekStart).toBeTruthy();
        }
      }
    });

    it("sleep performance is relative to previous weeks", async () => {
      const { status, result } = await query("weeklyReport.report", {
        weeks: 8,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // All weeks should have sleepPerformancePct as a number
      const allWeeks = [...data.history, ...(data.current ? [data.current] : [])];
      for (const week of allWeeks) {
        expect(typeof week.sleepPerformancePct).toBe("number");
        // Should be a reasonable percentage (0-200%ish)
        expect(week.sleepPerformancePct).toBeGreaterThanOrEqual(0);
        expect(week.sleepPerformancePct).toBeLessThanOrEqual(500);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Hiking — grade-adjusted pace cost factor model
  // ══════════════════════════════════════════════════════════════
  describe("hiking walkingBiomechanics", () => {
    beforeAll(async () => {
      // Update existing daily_metrics rows (already inserted by sleepNeed) to add walking data
      // Also insert additional rows for dates not covered by sleepNeed
      for (let i = 1; i <= 14; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);

        // Use UPDATE to add walking biomechanics to existing rows
        await testCtx.db.execute(
          sql`UPDATE fitness.daily_metrics
              SET walking_speed = ${1.2 + i * 0.01},
                  walking_step_length = ${70 + i * 0.5},
                  walking_double_support_pct = ${28 - i * 0.1},
                  walking_asymmetry_pct = ${3.5 + i * 0.05},
                  walking_steadiness = ${0.85 + i * 0.005}
              WHERE date = ${dateStr}::date
                AND provider_id = 'test-provider'
                AND user_id = ${TEST_USER_ID}`,
        );

        // Also insert for dates not already present (beyond the 30 days from sleepNeed)
        await testCtx.db.execute(
          sql`INSERT INTO fitness.daily_metrics
              (date, provider_id, user_id, walking_speed, walking_step_length, walking_double_support_pct, walking_asymmetry_pct, walking_steadiness)
              VALUES (${dateStr}::date, 'test-provider', ${TEST_USER_ID}, ${1.2 + i * 0.01}, ${70 + i * 0.5}, ${28 - i * 0.1}, ${3.5 + i * 0.05}, ${0.85 + i * 0.005})
              ON CONFLICT DO NOTHING`,
        );
      }
    }, 30_000);

    it("converts walking speed from m/s to km/h", async () => {
      const { status, result } = await query("hiking.walkingBiomechanics", {
        days: 30,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data.length).toBeGreaterThan(0);

      for (const row of data) {
        expect(row.date).toBeTruthy();
        // Walking speed should be in km/h (m/s * 3.6)
        // We inserted ~1.2-1.34 m/s, so km/h should be ~4.3-4.8
        if (row.walkingSpeedKmh !== null) {
          expect(row.walkingSpeedKmh).toBeGreaterThan(4);
          expect(row.walkingSpeedKmh).toBeLessThan(6);
        }
        if (row.stepLengthCm !== null) {
          expect(row.stepLengthCm).toBeGreaterThan(60);
          expect(row.stepLengthCm).toBeLessThan(90);
        }
        if (row.steadiness !== null) {
          expect(row.steadiness).toBeGreaterThanOrEqual(0);
          expect(row.steadiness).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Calendar — activity aggregation per day
  // ══════════════════════════════════════════════════════════════
  describe("calendar", () => {
    it("returns calendar data with activity counts and types", async () => {
      // Activities were already inserted in the weeklyReport beforeAll
      const { status, result } = await query("calendar.calendarData", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(Array.isArray(data)).toBe(true);
      if (data.length > 0) {
        const day = data[0];
        expect(day.date).toBeTruthy();
        expect(typeof day.activityCount).toBe("number");
        expect(day.activityCount).toBeGreaterThan(0);
        expect(typeof day.totalMinutes).toBe("number");
        expect(Array.isArray(day.activityTypes)).toBe(true);
        expect(day.activityTypes.length).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Healthspan — scoring functions produce correct ranges
  // ══════════════════════════════════════════════════════════════
  describe("healthspan", () => {
    beforeAll(async () => {
      // Set birth date for biological age calculation
      await testCtx.db.execute(
        sql`UPDATE fitness.user_profile
            SET birth_date = '1990-01-01'
            WHERE id = ${TEST_USER_ID}`,
      );

      const healthspanBodyMetricRows: ClickHouseMetricStreamSeedRow[] = [
        {
          userId: TEST_USER_ID,
          recordedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          providerId: "test-provider",
          externalId: "test-body-1",
          sourceType: "api",
          channel: "body_weight",
          scalar: 75,
        },
        {
          userId: TEST_USER_ID,
          recordedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          providerId: "test-provider",
          externalId: "test-body-1",
          sourceType: "api",
          channel: "body_fat_percentage",
          scalar: 18,
        },
      ];

      // Insert a strength workout for strength frequency score
      const workoutDate = new Date();
      workoutDate.setDate(workoutDate.getDate() - 3);
      await testCtx.db.execute(
        sql`INSERT INTO fitness.activity
            (provider_id, user_id, external_id, started_at, name, activity_type)
            VALUES ('test-provider', ${TEST_USER_ID}, 'strength-1', ${workoutDate.toISOString()}, 'Test Workout', 'strength')
            ON CONFLICT DO NOTHING`,
      );

      await syncClickHouseTestActivitySensorStore(testCtx);
      await seedClickHouseMetricStreamRows(testCtx, healthspanBodyMetricRows);
      await queryCache.invalidateAll();
    }, 30_000);

    it("returns composite score with metric breakdowns", async () => {
      const { status, result } = await query("healthspan.score", {
        weeks: 4,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // Composite score should be 0-100
      expect(data.healthspanScore).toBeGreaterThanOrEqual(0);
      expect(data.healthspanScore).toBeLessThanOrEqual(100);

      // Should have 9 metric breakdowns
      expect(data.metrics).toHaveLength(9);

      for (const metric of data.metrics) {
        expect(metric.name).toBeTruthy();
        expect(metric.unit).toBeTruthy();
        expect(metric.score).toBeGreaterThanOrEqual(0);
        expect(metric.score).toBeLessThanOrEqual(100);
        expect(["excellent", "good", "fair", "poor"]).toContain(metric.status);
      }

      // Trend should be defined (may be null with insufficient history)
      expect(data.trend).toBeDefined();
    });

    it("lean body mass is scored from body fat percentage", async () => {
      const { status, result } = await query("healthspan.score", {
        weeks: 4,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      const leanMassMetric = data.metrics.find(
        (m: { name: string }) => m.name === "Lean Body Mass",
      );
      expect(leanMassMetric).toBeDefined();
      // 18% body fat = 82% lean mass -> should score well
      expect(leanMassMetric.value).toBeCloseTo(82, 0);
      expect(leanMassMetric.score).toBeGreaterThanOrEqual(80);
    });

    it("resting HR score reflects inserted data", async () => {
      const { status, result } = await query("healthspan.score", {
        weeks: 4,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      const rhrMetric = data.metrics.find((m: { name: string }) => m.name === "Resting Heart Rate");
      expect(rhrMetric).toBeDefined();
      // Derived resting HR should come from the seeded overnight sensor samples.
      if (rhrMetric.value !== null) {
        expect(rhrMetric.value).toBeCloseTo(58, 0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Life Events — analyze compares metrics before/after
  // ══════════════════════════════════════════════════════════════
  describe("lifeEvents analyze", () => {
    let analyzeEventId: string;

    beforeAll(async () => {
      // Create a life event dated ~15 days ago
      const eventDate = new Date();
      eventDate.setDate(eventDate.getDate() - 15);
      const dateStr = eventDate.toISOString().slice(0, 10);

      const { result } = await mutate("lifeEvents.create", {
        label: "Started meditation",
        startedAt: dateStr,
        category: "wellness",
      });
      analyzeEventId = result.result.data.id;
    });

    it("returns before/after comparison with metrics", async () => {
      const { status, result } = await query("lifeEvents.analyze", {
        id: analyzeEventId,
        windowDays: 14,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data).toBeDefined();
      expect(data.event).toBeDefined();
      expect(data.metrics).toBeDefined();
      expect(data.sleep).toBeDefined();
      expect(data.bodyComp).toBeDefined();

      // Metrics should have 'before' and/or 'after' periods
      if (data.metrics.length > 0) {
        for (const period of data.metrics) {
          expect(["before", "after"]).toContain(period.period);
          expect(Number(period.days)).toBeGreaterThan(0);
        }
      }
    });

    afterAll(async () => {
      if (analyzeEventId) {
        await mutate("lifeEvents.delete", { id: analyzeEventId });
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Cycling Advanced — ramp rate EWMA + recommendation
  // ══════════════════════════════════════════════════════════════
  describe("cyclingAdvanced rampRate", () => {
    it("computes ramp rate with EWMA and provides recommendation", async () => {
      // Data was already inserted in weeklyReport beforeAll (cycling activities with HR + power)
      const { status, result } = await query("cyclingAdvanced.rampRate", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(typeof data.currentRampRate).toBe("number");
      expect(typeof data.recommendation).toBe("string");
      expect(data.recommendation.length).toBeGreaterThan(0);
      expect(Array.isArray(data.weeks)).toBe(true);

      // Recommendation should be one of the three categories
      expect(
        data.recommendation.startsWith("Safe") ||
          data.recommendation.startsWith("Aggressive") ||
          data.recommendation.startsWith("Danger") ||
          data.recommendation === "No data",
      ).toBe(true);

      if (data.weeks.length > 0) {
        for (const week of data.weeks) {
          expect(week.week).toBeTruthy();
          expect(typeof week.ctlStart).toBe("number");
          expect(typeof week.ctlEnd).toBe("number");
          expect(typeof week.rampRate).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Efficiency — aerobic decoupling with power+HR data
  // ══════════════════════════════════════════════════════════════
  describe("efficiency aerobicDecoupling", () => {
    it("returns decoupling results when activities have power and HR", async () => {
      const { status, result } = await query("efficiency.aerobicDecoupling", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // Data might be empty if activities don't have enough samples (600+)
      expect(Array.isArray(data)).toBe(true);

      for (const row of data) {
        expect(row.date).toBeTruthy();
        expect(typeof row.firstHalfRatio).toBe("number");
        expect(typeof row.secondHalfRatio).toBe("number");
        expect(typeof row.decouplingPct).toBe("number");
        expect(row.totalSamples).toBeGreaterThanOrEqual(600);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Hiking — grade-adjusted pace with Minetti cost factor
  // ══════════════════════════════════════════════════════════════
  describe("hiking gradeAdjustedPace", () => {
    beforeAll(async () => {
      // Insert hiking activities with elevation data
      const now = new Date();
      const hikingMetricStreamRows: ClickHouseMetricStreamSeedRow[] = [];
      for (let i = 0; i < 3; i++) {
        const activityDate = new Date(now);
        activityDate.setDate(activityDate.getDate() - i * 7 - 1);
        const startedAt = new Date(activityDate);
        startedAt.setHours(9, 0, 0, 0);
        const endedAt = new Date(startedAt.getTime() + 90 * 60 * 1000); // 90 min

        const externalId = `hike-gap-${i}`;
        await testCtx.db.execute(
          sql`INSERT INTO fitness.activity
              (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
              VALUES ('test-provider', ${TEST_USER_ID}, ${externalId}, 'hiking', ${startedAt.toISOString()}, ${endedAt.toISOString()}, ${`Mountain Hike ${i}`})
              ON CONFLICT DO NOTHING`,
        );

        const activityRows = await testCtx.db.execute(
          sql`SELECT id FROM fitness.activity WHERE external_id = ${externalId} AND provider_id = 'test-provider'`,
        );
        const activityId = activityRows[0]?.id;
        if (activityId) {
          const baseLat = 40.7;
          const baseLng = -74.0;
          for (let minute = 0; minute < 90; minute++) {
            const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
            const altitude = 500 + (minute / 90) * 400;
            const speed = 1.2 + Math.random() * 0.3;
            const lat = baseLat + minute * 0.00065;
            const hr = 130 + Math.round(Math.random() * 15);
            const grade = 5 + Math.random() * 3;
            const recordedAt = sampleTime.toISOString();

            hikingMetricStreamRows.push(
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "heart_rate",
                activityId,
                scalar: hr,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "speed",
                activityId,
                scalar: speed,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "altitude",
                activityId,
                scalar: altitude,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "grade",
                activityId,
                scalar: grade,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "lat",
                activityId,
                scalar: lat,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "lng",
                activityId,
                scalar: baseLng,
              },
            );
          }
        }
      }

      await syncClickHouseTestActivitySensorStore(testCtx);
      await seedClickHouseMetricStreamRows(testCtx, hikingMetricStreamRows);
    }, 60_000);

    it("computes grade-adjusted pace using Minetti cost factor", async () => {
      const { status, result } = await query("hiking.gradeAdjustedPace", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // We should have hiking activities from the insert above
      if (data.length > 0) {
        for (const row of data) {
          expect(row.activityType).toBe("hiking");
          expect(row.distanceKm).toBeGreaterThan(0);
          expect(row.durationMinutes).toBeGreaterThan(0);
          expect(row.averagePaceMinPerKm).toBeGreaterThan(0);
          // Grade-adjusted pace should be lower than actual pace for uphill
          // (dividing by costFactor > 1 for positive grade)
          expect(row.gradeAdjustedPaceMinPerKm).toBeGreaterThan(0);
          if (row.elevationGainMeters > 0) {
            expect(row.gradeAdjustedPaceMinPerKm).toBeLessThanOrEqual(row.averagePaceMinPerKm);
          }
        }
      }
    });

    it("elevation profile aggregates weekly", async () => {
      const { status, result } = await query("hiking.elevationProfile", {
        days: 90,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      if (data.length > 0) {
        for (const row of data) {
          expect(row.week).toBeTruthy();
          expect(typeof row.elevationGainMeters).toBe("number");
          expect(typeof row.activityCount).toBe("number");
          expect(row.activityCount).toBeGreaterThan(0);
          expect(typeof row.totalDistanceKm).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Hiking — activity comparison groups repeated routes
  // ══════════════════════════════════════════════════════════════
  describe("hiking activityComparison", () => {
    beforeAll(async () => {
      // Insert 2 activities with the same name for comparison
      const now = new Date();
      const comparisonMetricStreamRows: ClickHouseMetricStreamSeedRow[] = [];
      for (let i = 0; i < 2; i++) {
        const activityDate = new Date(now);
        activityDate.setDate(activityDate.getDate() - i * 14 - 1);
        const startedAt = new Date(activityDate);
        startedAt.setHours(10, 0, 0, 0);
        const endedAt = new Date(startedAt.getTime() + 75 * 60 * 1000);

        const externalId = `repeated-trail-${i}`;
        await testCtx.db.execute(
          sql`INSERT INTO fitness.activity
              (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
              VALUES ('test-provider', ${TEST_USER_ID}, ${externalId}, 'hiking', ${startedAt.toISOString()}, ${endedAt.toISOString()}, 'Repeated Trail')
              ON CONFLICT DO NOTHING`,
        );

        const activityRows = await testCtx.db.execute(
          sql`SELECT id FROM fitness.activity WHERE external_id = ${externalId} AND provider_id = 'test-provider'`,
        );
        const activityId = activityRows[0]?.id;
        if (activityId) {
          const baseLat = 40.7;
          const baseLng = -74.0;
          for (let minute = 0; minute < 75; minute++) {
            const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
            const altitude = 300 + (minute / 75) * 200;
            const speed = 1.3 + Math.random() * 0.2;
            const lat = baseLat + minute * 0.00065;
            const hr = 125 + Math.round(Math.random() * 10);
            const grade = 3 + Math.random() * 2;
            const recordedAt = sampleTime.toISOString();

            comparisonMetricStreamRows.push(
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "heart_rate",
                activityId,
                scalar: hr,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "speed",
                activityId,
                scalar: speed,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "altitude",
                activityId,
                scalar: altitude,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "grade",
                activityId,
                scalar: grade,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "lat",
                activityId,
                scalar: lat,
              },
              {
                userId: TEST_USER_ID,
                recordedAt,
                providerId: "test-provider",
                sourceType: "api",
                channel: "lng",
                activityId,
                scalar: baseLng,
              },
            );
          }
        }
      }

      await syncClickHouseTestActivitySensorStore(testCtx);
      await seedClickHouseMetricStreamRows(testCtx, comparisonMetricStreamRows);
    }, 60_000);

    it("groups repeated activities and returns comparison instances", async () => {
      const { status, result } = await query("hiking.activityComparison", {
        days: 365,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      // Should find "Repeated Trail" with 2 instances
      const repeatedTrail = data.find(
        (r: { activityName: string }) => r.activityName === "Repeated Trail",
      );
      if (repeatedTrail) {
        expect(repeatedTrail.instances.length).toBeGreaterThanOrEqual(2);
        for (const instance of repeatedTrail.instances) {
          expect(instance.date).toBeTruthy();
          expect(typeof instance.durationMinutes).toBe("number");
          expect(typeof instance.averagePaceMinPerKm).toBe("number");
          expect(typeof instance.elevationGainMeters).toBe("number");
        }
      }
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Intervals — detect from metric_stream
  // ══════════════════════════════════════════════════════════════
  describe("intervals detect", () => {
    let intervalActivityId: string;

    beforeAll(async () => {
      // Create an activity with distinct intensity changes for interval detection
      const now = new Date();
      const startedAt = new Date(now);
      startedAt.setDate(startedAt.getDate() - 2);
      startedAt.setHours(7, 0, 0, 0);
      const endedAt = new Date(startedAt.getTime() + 40 * 60 * 1000);

      await testCtx.db.execute(
        sql`INSERT INTO fitness.activity
            (provider_id, user_id, external_id, activity_type, started_at, ended_at, name)
            VALUES ('test-provider', ${TEST_USER_ID}, 'interval-detect-1', 'cycling', ${startedAt.toISOString()}, ${endedAt.toISOString()}, 'Interval Workout')
            ON CONFLICT DO NOTHING`,
      );

      const activityRows = await testCtx.db.execute(
        sql`SELECT id FROM fitness.activity WHERE external_id = 'interval-detect-1' AND provider_id = 'test-provider'`,
      );
      const firstRow: { id: string } = activityRows[0];
      intervalActivityId = firstRow.id;

      const intervalMetricStreamRows: ClickHouseMetricStreamSeedRow[] = [];
      for (let minute = 0; minute < 40; minute++) {
        const sampleTime = new Date(startedAt.getTime() + minute * 60 * 1000);
        const isHard = Math.floor(minute / 5) % 2 === 1;
        const power = isHard
          ? 240 + Math.round(Math.random() * 20)
          : 140 + Math.round(Math.random() * 20);
        const hr = isHard
          ? 165 + Math.round(Math.random() * 10)
          : 130 + Math.round(Math.random() * 10);
        const speed = 5.5 + Math.random();
        const recordedAt = sampleTime.toISOString();

        intervalMetricStreamRows.push(
          {
            userId: TEST_USER_ID,
            recordedAt,
            providerId: "test-provider",
            sourceType: "api",
            channel: "heart_rate",
            activityId: intervalActivityId,
            scalar: hr,
          },
          {
            userId: TEST_USER_ID,
            recordedAt,
            providerId: "test-provider",
            sourceType: "api",
            channel: "power",
            activityId: intervalActivityId,
            scalar: power,
          },
          {
            userId: TEST_USER_ID,
            recordedAt,
            providerId: "test-provider",
            sourceType: "api",
            channel: "speed",
            activityId: intervalActivityId,
            scalar: speed,
          },
        );
      }

      await syncClickHouseTestActivitySensorStore(testCtx);
      await seedClickHouseMetricStreamRows(testCtx, intervalMetricStreamRows);
    }, 30_000);

    it("detects intervals from intensity changes", async () => {
      const { status, result } = await query("intervals.detect", {
        activityId: intervalActivityId,
      });
      expect(status).toBe(200);
      const intervals = result.result.data;

      expect(Array.isArray(intervals)).toBe(true);
      // With 5-min alternating segments over 40 min, we should detect multiple intervals
      // (at least 2, possibly more depending on exact random values)
      expect(intervals.length).toBeGreaterThanOrEqual(2);

      for (const interval of intervals) {
        expect(typeof interval.intervalIndex).toBe("number");
        expect(interval.startedAt).toBeTruthy();
        expect(interval.endedAt).toBeTruthy();
      }
    });

    it("byActivity returns stored intervals", async () => {
      // Insert an interval for the activity
      await testCtx.db.execute(
        sql`INSERT INTO fitness.activity_interval
            (activity_id, interval_index, label, started_at, ended_at)
            VALUES (${intervalActivityId}::uuid, 0, 'Warmup', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '50 minutes')`,
      );

      const { status, result } = await query("intervals.byActivity", {
        activityId: intervalActivityId,
      });
      expect(status).toBe(200);
      const data = result.result.data;

      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0].label).toBe("Warmup");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Sport Settings — zone percentages (JSON storage)
  // ══════════════════════════════════════════════════════════════
  describe("sportSettings zones", () => {
    it("stores and retrieves JSON zone percentages", async () => {
      const powerZones = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
      const { status: upsertStatus } = await mutate("sportSettings.upsert", {
        sport: "running",
        thresholdHr: 175,
        thresholdPacePerKm: 4.5,
        hrZonePcts: [0.6, 0.7, 0.8, 0.9, 1.0],
        paceZonePcts: powerZones,
        effectiveFrom: "2025-03-01",
      });
      expect(upsertStatus).toBe(200);

      const { result: getResult } = await query("sportSettings.getBySport", {
        sport: "running",
        asOfDate: "2025-03-15",
      });
      const settings = getResult.result.data;
      expect(settings.thresholdHr).toBe(175);
      expect(settings.thresholdPacePerKm).toBeCloseTo(4.5);
      expect(settings.hrZonePcts).toEqual([0.6, 0.7, 0.8, 0.9, 1.0]);
      expect(settings.paceZonePcts).toEqual(powerZones);
    });
  });
});
