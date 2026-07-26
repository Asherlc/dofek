import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { SyncRepository } from "./sync-repository.ts";

const SYNC_REPOSITORY_TEST_USER_ID = "00000000-0000-0000-0000-0000000000f2";
const SECOND_SYNC_REPOSITORY_TEST_USER_ID = "00000000-0000-0000-0000-0000000000f3";

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
          WHERE user_id = ${SYNC_REPOSITORY_TEST_USER_ID}
            AND provider_id = 'sync-repository-provider'`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.provider_connection
          WHERE provider_id = 'sync-repository-provider'`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.provider
          WHERE id = 'sync-repository-provider'`,
    );
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
        expect.objectContaining({ providerId: "sync-repository-provider" }),
      ]);
      await expect(secondRepository.getConnectedProviderIds()).resolves.toEqual([
        expect.objectContaining({ providerId: "sync-repository-provider" }),
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
