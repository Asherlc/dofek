import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "../../../../src/db/execute-with-schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../../../src/db/tokens.ts";
import { SyncRepository } from "./sync-repository.ts";

const SYNC_REPOSITORY_TEST_USER_ID = "00000000-0000-0000-0000-0000000000f2";
const SECOND_SYNC_REPOSITORY_TEST_USER_ID = "00000000-0000-0000-0000-0000000000f3";
const SYNC_REPOSITORY_PROVIDER_IDS = [
  "sync-repository-provider",
  "sync-repository-historical-provider",
  "sync-repository-other-provider",
];

interface QueryPlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: QueryPlanNode[];
}

const queryPlanNodeSchema: z.ZodType<QueryPlanNode> = z.lazy(() =>
  z.object({
    "Node Type": z.string(),
    "Index Name": z.string().optional(),
    "Relation Name": z.string().optional(),
    "Actual Rows": z.number(),
    "Actual Loops": z.number(),
    "Rows Removed by Filter": z.number().optional(),
    Plans: z.array(queryPlanNodeSchema).optional(),
  }),
);
const explainPlanRowSchema = z.object({
  "QUERY PLAN": z.array(z.object({ Plan: queryPlanNodeSchema })).length(1),
});

function scannedSyncLogRows(plan: QueryPlanNode): number {
  const scannedRows =
    plan["Relation Name"] === "sync_log"
      ? (plan["Actual Rows"] + (plan["Rows Removed by Filter"] ?? 0)) * plan["Actual Loops"]
      : 0;
  return (
    scannedRows + (plan.Plans ?? []).reduce((total, child) => total + scannedSyncLogRows(child), 0)
  );
}

describe("SyncRepository integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${SYNC_REPOSITORY_TEST_USER_ID}, 'Sync Repository Test User'),
            (${SECOND_SYNC_REPOSITORY_TEST_USER_ID}, 'Second Sync Repository Test User')
          ON CONFLICT (id) DO NOTHING`,
    );
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  afterEach(async () => {
    await testContext.db.execute(
      sql`DELETE FROM fitness.sync_log
          WHERE provider_id = ANY(${sql.param(SYNC_REPOSITORY_PROVIDER_IDS)}::text[])`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.oauth_token
          WHERE provider_id = ANY(${sql.param(SYNC_REPOSITORY_PROVIDER_IDS)}::text[])`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.provider_connection
          WHERE provider_id = ANY(${sql.param(SYNC_REPOSITORY_PROVIDER_IDS)}::text[])`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.provider
          WHERE id = ANY(${sql.param(SYNC_REPOSITORY_PROVIDER_IDS)}::text[])`,
    );
  });

  describe("getRecentLogsByProvider", () => {
    async function seedProviders(): Promise<void> {
      await testContext.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES
              ('sync-repository-provider', 'Sync Repository Provider', NULL),
              (
                'sync-repository-historical-provider',
                'Historical Provider',
                ${SECOND_SYNC_REPOSITORY_TEST_USER_ID}
              ),
              ('sync-repository-other-provider', 'Other Provider', NULL)`,
      );
    }

    it("returns the latest limit for each provider with descending timestamp and id ties", async () => {
      await seedProviders();
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (id, provider_id, user_id, data_type, status, synced_at)
            VALUES
              ('00000000-0000-4000-8000-000000000099', 'sync-repository-provider',
               ${SYNC_REPOSITORY_TEST_USER_ID}, 'sync', 'success', '2026-07-09T10:00:00Z'),
              ('00000000-0000-4000-8000-000000000002', 'sync-repository-provider',
               ${SYNC_REPOSITORY_TEST_USER_ID}, 'sync', 'error', '2026-07-09T12:00:00Z'),
              ('00000000-0000-4000-8000-000000000003', 'sync-repository-provider',
               ${SYNC_REPOSITORY_TEST_USER_ID}, 'sync', 'success', '2026-07-09T12:00:00Z'),
              ('00000000-0000-4000-8000-000000000004', 'sync-repository-provider',
               ${SYNC_REPOSITORY_TEST_USER_ID}, 'sync', 'degraded', '2026-07-09T12:00:00Z'),
              ('00000000-0000-4000-8000-000000000005', 'sync-repository-other-provider',
               ${SYNC_REPOSITORY_TEST_USER_ID}, 'activities', 'success', '2026-07-09T11:00:00Z'),
              ('00000000-0000-4000-8000-000000000006', 'sync-repository-other-provider',
               ${SYNC_REPOSITORY_TEST_USER_ID}, 'activities', 'error', '2026-07-09T13:00:00Z')`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);
      const logs = await repository.getRecentLogsByProvider(2);

      expect([...logs.keys()]).toEqual([
        "sync-repository-other-provider",
        "sync-repository-provider",
      ]);
      expect(logs.get("sync-repository-provider")).toEqual([
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000004",
          status: "degraded",
          syncedAt: "2026-07-09T12:00:00.000Z",
        }),
        expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000003",
          status: "success",
          syncedAt: "2026-07-09T12:00:00.000Z",
        }),
      ]);
      expect(logs.get("sync-repository-other-provider")).toEqual([
        expect.objectContaining({ id: "00000000-0000-4000-8000-000000000006" }),
        expect.objectContaining({ id: "00000000-0000-4000-8000-000000000005" }),
      ]);
      await expect(repository.getRecentLogsByProvider(0)).resolves.toEqual(new Map());
    });

    it("keeps another user's newer logs out of each provider's history", async () => {
      await seedProviders();
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status, record_count, synced_at)
            VALUES
              ('sync-repository-provider', ${SYNC_REPOSITORY_TEST_USER_ID},
               'sync', 'success', 12, '2026-07-09T10:00:00Z'),
              ('sync-repository-provider', ${SECOND_SYNC_REPOSITORY_TEST_USER_ID},
               'sync', 'error', 99, '2026-07-09T12:00:00Z'),
              ('sync-repository-other-provider', ${SECOND_SYNC_REPOSITORY_TEST_USER_ID},
               'sync', 'success', 100, '2026-07-09T12:00:00Z')`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);

      await expect(repository.getRecentLogsByProvider(3)).resolves.toEqual(
        new Map([
          [
            "sync-repository-provider",
            [expect.objectContaining({ recordCount: 12, status: "success" })],
          ],
        ]),
      );
    });

    it("retains disconnected and unconfigured history regardless of catalog user ownership", async () => {
      await seedProviders();
      await ensureProvider(
        testContext.db,
        "sync-repository-provider",
        "Sync Repository Provider",
        undefined,
        SYNC_REPOSITORY_TEST_USER_ID,
      );
      await testContext.db.execute(
        sql`DELETE FROM fitness.provider_connection
            WHERE user_id = ${SYNC_REPOSITORY_TEST_USER_ID}
              AND provider_id = 'sync-repository-provider'`,
      );
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status, synced_at)
            VALUES
              ('sync-repository-provider', ${SYNC_REPOSITORY_TEST_USER_ID},
               'sync', 'success', '2026-07-09T10:00:00Z'),
              ('sync-repository-historical-provider', ${SYNC_REPOSITORY_TEST_USER_ID},
               'sync', 'error', '2026-07-09T12:00:00Z')`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);
      const logs = await repository.getRecentLogsByProvider(3);

      expect([...logs.keys()]).toEqual([
        "sync-repository-historical-provider",
        "sync-repository-provider",
      ]);
      expect(logs.get("sync-repository-historical-provider")).toEqual([
        expect.objectContaining({ status: "error", syncedAt: "2026-07-09T12:00:00.000Z" }),
      ]);
    });

    it("returns no provider histories when the user has no logs", async () => {
      await seedProviders();
      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);

      await expect(repository.getRecentLogsByProvider(3)).resolves.toEqual(new Map());
    });

    it.each([
      { timestamps: "distinct", secondsPerEntry: 1 },
      { timestamps: "equal", secondsPerEntry: 0 },
    ])("reads bounded log rows with 10,000 $timestamps timestamps", async ({ secondsPerEntry }) => {
      await seedProviders();
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (id, provider_id, user_id, data_type, status, record_count, synced_at)
            SELECT ('00000000-0000-4000-8000-' || lpad(entry::text, 12, '0'))::uuid,
                   'sync-repository-provider', ${SYNC_REPOSITORY_TEST_USER_ID}, 'sync',
                   'success', entry,
                   '2026-07-01T00:00:00Z'::timestamptz + entry * ${secondsPerEntry}::int * INTERVAL '1 second'
            FROM generate_series(1, 10000) AS entry`,
      );
      await testContext.db.execute(sql`ANALYZE fitness.provider, fitness.sync_log`);

      let repositoryQuery: Parameters<TestContext["db"]["execute"]>[0] | undefined;
      const execute: TestContext["db"]["execute"] = (query) => {
        repositoryQuery = query;
        return testContext.db.execute(query);
      };
      const repository = new SyncRepository(
        { execute, select: testContext.db.select },
        SYNC_REPOSITORY_TEST_USER_ID,
      );
      const logs = await repository.getRecentLogsByProvider(3);

      expect(logs.get("sync-repository-provider")?.map((log) => log.recordCount)).toEqual([
        10000, 9999, 9998,
      ]);
      if (repositoryQuery === undefined || typeof repositoryQuery === "string") {
        throw new Error("Expected the repository to execute a parameterized history query");
      }
      const [explained] = await executeWithSchema(
        testContext.db,
        explainPlanRowSchema,
        sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${repositoryQuery}`,
      );
      const plan = explained?.["QUERY PLAN"][0]?.Plan;
      if (!plan) throw new Error("PostgreSQL did not return a history query plan");

      const scannedRows = scannedSyncLogRows(plan);
      expect(scannedRows).toBeGreaterThan(0);
      expect(
        scannedRows,
        `Fetching three recent logs must not scan all historical logs: ${JSON.stringify(plan)}`,
      ).toBeLessThan(100);
    });
  });

  describe("last sync timestamps", () => {
    it("returns ISO strings from PostgreSQL timestamptz rows for both last-sync queries", async () => {
      await testContext.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('sync-repository-provider', 'Sync Repository Provider', ${SYNC_REPOSITORY_TEST_USER_ID})`,
      );
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status, origin, synced_at)
            VALUES
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'activities',
                'success',
                'scheduled',
                '2026-07-09T12:00:00Z'
              ),
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'activities',
                'error',
                'unknown',
                '2026-07-09T13:00:00Z'
              )`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);

      await expect(repository.getLastSyncTimes()).resolves.toEqual([
        {
          providerId: "sync-repository-provider",
          lastSynced: "2026-07-09T13:00:00.000Z",
        },
      ]);
      await expect(repository.getLastSuccessfulSyncTimes()).resolves.toEqual([
        {
          providerId: "sync-repository-provider",
          lastSynced: "2026-07-09T12:00:00.000Z",
        },
      ]);
    });

    it("ignores a newer successful manual sync when reporting scheduled freshness", async () => {
      await testContext.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('sync-repository-provider', 'Sync Repository Provider', ${SYNC_REPOSITORY_TEST_USER_ID})`,
      );
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status, origin, synced_at)
            VALUES
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'activities',
                'success',
                'scheduled',
                '2026-07-09T12:00:00Z'
              ),
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'activities',
                'success',
                'manual',
                '2026-07-09T13:00:00Z'
              )`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);

      await expect(repository.getLastSuccessfulSyncTimes()).resolves.toEqual([
        {
          providerId: "sync-repository-provider",
          lastSynced: "2026-07-09T12:00:00.000Z",
        },
      ]);
    });
  });

  describe("getLatestErrors", () => {
    it("returns an error when the latest provider sync timestamp also has a success row", async () => {
      await testContext.db.execute(
        sql`INSERT INTO fitness.provider (id, name, user_id)
            VALUES ('sync-repository-provider', 'Sync Repository Provider', ${SYNC_REPOSITORY_TEST_USER_ID})
            ON CONFLICT DO NOTHING`,
      );
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (
              provider_id,
              user_id,
              data_type,
              status,
              error_message,
              auth_failure_reason,
              synced_at
            )
            VALUES
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'activities',
                'error',
                'authorization failed',
                'authorization_failed',
                '2026-07-09T12:00:00Z'
              ),
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'daily_metrics',
                'success',
                NULL,
                NULL,
                '2026-07-09T12:00:00Z'
              ),
              (
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'sleep_sessions',
                'error',
                'old error',
                'authorization_failed',
                '2026-07-08T12:00:00Z'
              )`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);

      await expect(repository.getLatestErrors()).resolves.toEqual([
        {
          providerId: "sync-repository-provider",
          errorMessage: "authorization failed",
          authFailureReason: "authorization_failed",
          syncedAt: new Date("2026-07-09T12:00:00Z"),
        },
      ]);
    });
  });

  describe("getScheduledSyncHealth", () => {
    it("counts an error after an equal-timestamp success using the defined id ordering", async () => {
      await ensureProvider(
        testContext.db,
        "sync-repository-provider",
        "Sync Repository Provider",
        undefined,
        SYNC_REPOSITORY_TEST_USER_ID,
      );
      await testContext.db.execute(
        sql`INSERT INTO fitness.sync_log (
              id,
              provider_id,
              user_id,
              data_type,
              status,
              error_message,
              origin,
              synced_at
            )
            VALUES
              (
                '00000000-0000-4000-8000-000000000001',
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'sync',
                'success',
                NULL,
                'scheduled',
                '2026-07-09T12:00:00Z'
              ),
              (
                '00000000-0000-4000-8000-000000000002',
                'sync-repository-provider',
                ${SYNC_REPOSITORY_TEST_USER_ID},
                'sync',
                'error',
                'later attempt failed',
                'scheduled',
                '2026-07-09T12:00:00Z'
              )`,
      );

      const repository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);

      await expect(repository.getScheduledSyncHealth()).resolves.toEqual([
        {
          providerId: "sync-repository-provider",
          lastSuccess: "2026-07-09T12:00:00.000Z",
          lastAttempt: "2026-07-09T12:00:00.000Z",
          lastError: "later attempt failed",
          consecutiveFailures: 1,
        },
      ]);
    });
  });

  describe("getConnectedProviderIds", () => {
    it("lists and disconnects the same provider independently for two users", async () => {
      await ensureProvider(
        testContext.db,
        "sync-repository-provider",
        "Sync Repository Provider",
        undefined,
        SYNC_REPOSITORY_TEST_USER_ID,
      );
      await ensureProvider(
        testContext.db,
        "sync-repository-provider",
        "Sync Repository Provider",
        undefined,
        SECOND_SYNC_REPOSITORY_TEST_USER_ID,
      );

      const firstRepository = new SyncRepository(testContext.db, SYNC_REPOSITORY_TEST_USER_ID);
      const secondRepository = new SyncRepository(
        testContext.db,
        SECOND_SYNC_REPOSITORY_TEST_USER_ID,
      );

      await expect(firstRepository.getConnectedProviderIds()).resolves.toEqual([
        expect.objectContaining({
          providerId: "sync-repository-provider",
          hasTokens: false,
        }),
      ]);
      await expect(secondRepository.getConnectedProviderIds()).resolves.toEqual([
        expect.objectContaining({
          providerId: "sync-repository-provider",
          hasTokens: false,
        }),
      ]);

      await saveTokens(
        testContext.db,
        "sync-repository-provider",
        {
          accessToken: "first-user-token",
          refreshToken: null,
          expiresAt: new Date("2026-08-01T00:00:00Z"),
          scopes: null,
        },
        SYNC_REPOSITORY_TEST_USER_ID,
      );

      await expect(firstRepository.getConnectedProviderIds()).resolves.toEqual([
        expect.objectContaining({
          providerId: "sync-repository-provider",
          hasTokens: true,
        }),
      ]);
      await expect(secondRepository.getConnectedProviderIds()).resolves.toEqual([
        expect.objectContaining({
          providerId: "sync-repository-provider",
          hasTokens: false,
        }),
      ]);

      await testContext.db.execute(
        sql`DELETE FROM fitness.provider_connection
            WHERE user_id = ${SYNC_REPOSITORY_TEST_USER_ID}
              AND provider_id = 'sync-repository-provider'`,
      );

      await expect(firstRepository.getConnectedProviderIds()).resolves.toEqual([]);
      await expect(secondRepository.getConnectedProviderIds()).resolves.toEqual([
        expect.objectContaining({ providerId: "sync-repository-provider" }),
      ]);
    });
  });
});
