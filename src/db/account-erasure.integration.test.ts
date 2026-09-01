import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPostgresAccountErasureCoverage,
  erasePostgresAccount,
} from "../account-erasure/postgres-erasure.ts";
import type { AccountErasureRestoreIntent } from "../account-erasure/restore-ledger.ts";
import { createMetricStreamEvent } from "../metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
import { currentMetricStreamWriteDatabase } from "../metric-stream/write-fence-context.ts";
import { writeMetricStreamRows } from "../metric-stream/write-metric-stream.ts";
import { recordMetricStreamBatchPublishedInTransaction } from "../processing/processing-event-store.ts";
import {
  confirmAccountErasure,
  findAccountErasureStatus,
  initiateAccountErasure,
  isAccountErasureIdentityFenced,
  withAccountErasureIdentityWriteFence,
} from "./account-erasure.ts";
import {
  claimAccountErasureRequest,
  completeAccountErasure,
  deleteAccountErasureUserProfile,
  listPendingAccountErasureRequests,
  markAccountErasurePhaseCompleted,
  markAccountErasureWaiting,
  markOverdueAccountErasureRequests,
  scrubAccountErasureRequestPii,
} from "./account-erasure-processing.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const deletingUserId = "10000000-0000-4000-8000-000000001994";
const otherUserId = "20000000-0000-4000-8000-000000001994";
const concurrentUserId = "40000000-0000-4000-8000-000000001994";
const deletingDailyMetricsId = "50000000-0000-4000-8000-000000001994";
const metricRaceUserId = "60000000-0000-4000-8000-000000001994";
const metricRaceOperationId = "70000000-0000-4000-8000-000000001994";
const deadlineUserId = "80000000-0000-4000-8000-000000001994";
const identityRaceUserId = "90000000-0000-4000-8000-000000001994";
const recreatedIdentityUserId = "91000000-0000-4000-8000-000000001994";
const incompleteErasureUserId = "92000000-0000-4000-8000-000000001994";
const leaseOwner = "account-erasure-integration-worker";
const recoveryPreparationToken = "r".repeat(43);

async function waitForAdvisoryLockWait(connectionString: string): Promise<void> {
  const observer = new Client({ connectionString });
  await observer.connect();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_locks AS waiting_lock
           JOIN pg_stat_activity AS waiting_activity
             ON waiting_activity.pid = waiting_lock.pid
           JOIN pg_locks AS holding_lock
             ON holding_lock.locktype = waiting_lock.locktype
            AND holding_lock.database IS NOT DISTINCT FROM waiting_lock.database
            AND holding_lock.classid IS NOT DISTINCT FROM waiting_lock.classid
            AND holding_lock.objid IS NOT DISTINCT FROM waiting_lock.objid
            AND holding_lock.objsubid IS NOT DISTINCT FROM waiting_lock.objsubid
            AND holding_lock.pid <> waiting_lock.pid
           WHERE waiting_lock.locktype = 'advisory'
             AND waiting_lock.granted = false
             AND holding_lock.granted = true
             AND waiting_activity.datname = current_database()
             AND waiting_activity.wait_event = 'advisory'
             AND waiting_activity.query LIKE '%pg_advisory_xact_lock%'
         ) AS waiting`,
      );
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Account-erasure initiation never waited on the advisory lock");
  } finally {
    await observer.end();
  }
}

describe("account erasure persistence (integration)", () => {
  let context: TestContext;
  let requestId: string;
  let restoreIntent: AccountErasureRestoreIntent | null = null;
  let statusToken: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES
            (${deletingUserId}::uuid, 'Delete Me', 'delete-1994@example.test'),
            (${otherUserId}::uuid, 'Keep Me', 'keep-1994@example.test'),
            (${concurrentUserId}::uuid, 'Concurrent User', 'concurrent-1994@example.test'),
            (${metricRaceUserId}::uuid, 'Metric Race User', 'metric-race-1994@example.test'),
            (${deadlineUserId}::uuid, 'Deadline User', 'deadline-1994@example.test'),
            (${identityRaceUserId}::uuid, 'Identity Race User', 'identity-race-1994@example.test')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.user_settings (user_id, key, value)
          VALUES
            (${deletingUserId}::uuid, 'preexisting-delete', 'true'::jsonb),
            (${otherUserId}::uuid, 'preexisting-keep', 'true'::jsonb)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.session (id, user_id, expires_at)
          VALUES
            ('account-erasure-session-1', ${deletingUserId}::uuid, now() + interval '1 day'),
            ('account-erasure-session-2', ${deletingUserId}::uuid, now() + interval '1 day'),
            ('account-erasure-other-session', ${otherUserId}::uuid, now() + interval '1 day')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.companion_token (user_id, token_hash)
          VALUES (${deletingUserId}::uuid, repeat('a', 64))`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.auth_account (
            user_id, auth_provider, provider_account_id, email
          )
          VALUES (
            ${deletingUserId}::uuid,
            'google',
            'deleted-google-account',
            'Delete-Login@Example.Test'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.user_password_credential (
            user_id, email, password_hash
          )
          VALUES (
            ${deletingUserId}::uuid,
            'delete-password@example.test',
            'test-password-hash'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.shared_report (
            user_id, share_token, report_type, report_data
          )
          VALUES (
            ${deletingUserId}::uuid,
            'account-erasure-shared-link',
            'weekly',
            '{}'::jsonb
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metric_type (
            id, display_name, category, priority_category
          )
          VALUES
            ('account-erasure-existing', 'Existing', 'activity', 'activity'),
            ('account-erasure-blocked', 'Blocked', 'activity', 'activity')
          ON CONFLICT (id) DO NOTHING`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES ('apple_health', 'Apple Health')
          ON CONFLICT (id) DO NOTHING`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metrics (id, date, provider_id, user_id)
          VALUES (
            ${deletingDailyMetricsId}::uuid,
            '2026-07-26',
            'apple_health',
            ${deletingUserId}::uuid
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metric_value (
            daily_metrics_id, metric_type_id, value
          )
          VALUES (
            ${deletingDailyMetricsId}::uuid,
            'account-erasure-existing',
            1
          )`,
    );

    const result = await initiateAccountErasure(
      context.db,
      deletingUserId,
      async () => "encrypted-test-snapshot",
      async (intent) => {
        restoreIntent = intent;
      },
      {
        preparationTokenHash: createHash("sha256").update(recoveryPreparationToken).digest("hex"),
      },
    );
    requestId = result.requestId;
    statusToken = result.statusToken;
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("atomically revokes every session and creates a seven-day replay boundary", async () => {
    const rows = await context.db.execute(
      sql`SELECT
            (SELECT count(*)::int FROM fitness.session WHERE user_id = ${deletingUserId}::uuid)
              AS deleting_sessions,
            (SELECT count(*)::int FROM fitness.session WHERE user_id = ${otherUserId}::uuid)
              AS other_sessions,
            (SELECT count(*)::int FROM fitness.companion_token
              WHERE user_id = ${deletingUserId}::uuid) AS companion_tokens,
            (SELECT count(*)::int FROM fitness.shared_report
              WHERE user_id = ${deletingUserId}::uuid) AS shared_reports,
            replay_retained_until - requested_at AS replay_window,
            completion_deadline - requested_at AS completion_window
          FROM fitness.account_erasure_request
          WHERE id = ${requestId}::uuid`,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        completion_window: "30 days",
        companion_tokens: 0,
        deleting_sessions: 0,
        other_sessions: 1,
        replay_window: "7 days",
        shared_reports: 0,
      }),
    ]);
  });

  it("rejects direct writes for the deleting account without affecting another user", async () => {
    await expect(
      context.db.execute(
        sql`INSERT INTO fitness.user_settings (user_id, key, value)
            VALUES (${deletingUserId}::uuid, 'blocked', 'true'::jsonb)`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });

    await expect(
      context.db.execute(
        sql`INSERT INTO fitness.user_settings (user_id, key, value)
            VALUES (${otherUserId}::uuid, 'allowed', 'true'::jsonb)`,
      ),
    ).resolves.toBeDefined();
  });

  it("fences provider accounts and every normalized login email while erasure is active", async () => {
    await expect(
      isAccountErasureIdentityFenced(context.db, [
        {
          authProvider: "GOOGLE",
          kind: "provider_account",
          providerAccountId: "deleted-google-account",
        },
      ]),
    ).resolves.toBe(true);
    await expect(
      isAccountErasureIdentityFenced(context.db, [
        { email: " delete-login@example.test ", kind: "email" },
        { email: "delete-password@example.test", kind: "email" },
      ]),
    ).resolves.toBe(true);
    await expect(
      isAccountErasureIdentityFenced(context.db, [
        {
          authProvider: "google",
          kind: "provider_account",
          providerAccountId: "other-account",
        },
      ]),
    ).resolves.toBe(false);
  });

  it("rejects updates that move an existing row into or out of a deleting account", async () => {
    await expect(
      context.db.execute(
        sql`UPDATE fitness.user_settings
            SET user_id = ${otherUserId}::uuid
            WHERE user_id = ${deletingUserId}::uuid
              AND key = 'preexisting-delete'`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
    await expect(
      context.db.execute(
        sql`UPDATE fitness.user_settings
            SET user_id = ${deletingUserId}::uuid
            WHERE user_id = ${otherUserId}::uuid
              AND key = 'preexisting-keep'`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
  });

  it("serializes initiation with concurrent writes before capturing remote state", async () => {
    let concurrentWrite: Promise<unknown> | null = null;
    const result = await initiateAccountErasure(
      context.db,
      concurrentUserId,
      async () => {
        concurrentWrite = context.db.execute(
          sql`INSERT INTO fitness.auth_account (
                user_id, auth_provider, provider_account_id
              )
              VALUES (${concurrentUserId}::uuid, 'apple', 'concurrent-account')`,
        );
        return "encrypted-concurrent-snapshot";
      },
      async () => undefined,
    );

    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(concurrentWrite).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
  });

  it("serializes deletion with new-account identity reuse and rechecks after the fence commits", async () => {
    let releaseSnapshot: () => void = () => {
      throw new Error("snapshot release was not initialized");
    };
    let reportSnapshotStarted: () => void = () => {
      throw new Error("snapshot start signal was not initialized");
    };
    const snapshotStarted = new Promise<void>((resolve) => {
      reportSnapshotStarted = resolve;
    });
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const initiation = initiateAccountErasure(
      context.db,
      identityRaceUserId,
      async () => {
        reportSnapshotStarted();
        await snapshotReleased;
        return "encrypted-identity-race-snapshot";
      },
      async () => undefined,
    );
    await snapshotStarted;

    const registration = withAccountErasureIdentityWriteFence(
      context.db,
      [
        {
          email: "IDENTITY-RACE-1994@example.test",
          kind: "email",
        },
      ],
      (transaction) =>
        transaction.execute(
          sql`INSERT INTO fitness.user_profile (id, name, email)
              VALUES (
                ${recreatedIdentityUserId}::uuid,
                'Must Not Recreate',
                'identity-race-1994@example.test'
              )`,
        ),
    );
    await waitForAdvisoryLockWait(context.connectionString);
    releaseSnapshot();

    await expect(initiation).resolves.toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    await expect(registration).rejects.toThrow(
      "identity belongs to an account that is currently being deleted",
    );
    await expect(
      context.db.execute(
        sql`SELECT id
            FROM fitness.user_profile
            WHERE id = ${recreatedIdentityUserId}::uuid`,
      ),
    ).resolves.toEqual([]);
  });

  it("holds the same advisory lock through processing-aware metric publication", async () => {
    await context.db.execute(
      sql`INSERT INTO fitness.processing_operation (
            id, user_id, provider_id, kind, external_correlation_key, dataset_keys
          )
          VALUES (
            ${metricRaceOperationId}::uuid,
            ${metricRaceUserId}::uuid,
            'apple_health',
            'push_ingest',
            'account-erasure-metric-race',
            ARRAY['recovery']::text[]
          )`,
    );
    let releasePublish: () => void = () => {
      throw new Error("Publish release was not initialized");
    };
    let reportIntentPersisted: () => void = () => {
      throw new Error("Intent signal was not initialized");
    };
    const intentPersisted = new Promise<void>((resolve) => {
      reportIntentPersisted = resolve;
    });
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publisher: MetricStreamEventPublisher = {
      publishRows: async (rows, options) => {
        const transaction = currentMetricStreamWriteDatabase();
        if (!transaction) {
          throw new Error("Metric stream write transaction was not propagated");
        }
        await recordMetricStreamBatchPublishedInTransaction(transaction, {
          batchId: "account-erasure-metric-race",
          datasetKeys: ["recovery"],
          expectedEventCount: rows.length,
          operationId: metricRaceOperationId,
        });
        reportIntentPersisted();
        await publishReleased;
        return rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
      },
    };
    const metricWrite = writeMetricStreamRows({
      database: context.db,
      publisher,
      rows: [
        {
          channel: "heart_rate",
          externalId: "account-erasure-race-sample",
          providerId: "apple_health",
          recordedAt: "2026-07-26T12:00:00.000Z",
          scalar: 70,
          sourceType: "api",
          userId: metricRaceUserId,
        },
      ],
    });
    await intentPersisted;

    let snapshotCaptured = false;
    const initiation = initiateAccountErasure(
      context.db,
      metricRaceUserId,
      async () => {
        snapshotCaptured = true;
        return "encrypted-metric-race-snapshot";
      },
      async () => undefined,
    );
    await waitForAdvisoryLockWait(context.connectionString);
    expect(snapshotCaptured).toBe(false);

    releasePublish();
    await expect(metricWrite).resolves.toEqual(expect.objectContaining({ published: 1 }));
    await expect(initiation).resolves.toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(snapshotCaptured).toBe(true);

    await expect(
      writeMetricStreamRows({
        database: context.db,
        publisher,
        rows: [
          {
            channel: "heart_rate",
            externalId: "account-erasure-blocked-sample",
            providerId: "apple_health",
            recordedAt: "2026-07-26T12:01:00.000Z",
            scalar: 71,
            sourceType: "api",
            userId: metricRaceUserId,
          },
        ],
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
  });

  it("installs the write fence on every current direct user-scoped table", async () => {
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
    const rows = await context.db.execute(
      sql`SELECT columns.table_name
          FROM information_schema.columns AS columns
          JOIN information_schema.tables AS tables
            ON tables.table_schema = columns.table_schema
            AND tables.table_name = columns.table_name
          WHERE columns.table_schema = 'fitness'
            AND columns.column_name = 'user_id'
            AND columns.table_name NOT LIKE 'account_erasure_%'
            AND tables.table_type = 'BASE TABLE'
            AND NOT fitness.account_erasure_relation_is_ownership_neutral(
              to_regclass(
                format('%I.%I', columns.table_schema, columns.table_name)
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM pg_trigger
              JOIN pg_class ON pg_class.oid = pg_trigger.tgrelid
              JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
              WHERE pg_namespace.nspname = 'fitness'
                AND pg_class.relname = columns.table_name
                AND pg_trigger.tgname = 'account_erasure_write_fence'
                AND NOT pg_trigger.tgisinternal
            )
          ORDER BY columns.table_name`,
    );

    expect(rows).toEqual([]);
  });

  it("installs and enforces an indirect fence for every child of a user-owned table", async () => {
    const uncoveredRelationships = await context.db.execute(
      sql`SELECT
            child.relname AS child_table,
            child_column.attname AS child_column
          FROM pg_constraint AS foreign_key
          JOIN pg_class AS child ON child.oid = foreign_key.conrelid
          JOIN pg_namespace AS child_namespace
            ON child_namespace.oid = child.relnamespace
          JOIN pg_class AS parent ON parent.oid = foreign_key.confrelid
          JOIN pg_namespace AS parent_namespace
            ON parent_namespace.oid = parent.relnamespace
          JOIN pg_attribute AS child_column
            ON child_column.attrelid = child.oid
            AND child_column.attnum = foreign_key.conkey[1]
          WHERE foreign_key.contype = 'f'
            AND cardinality(foreign_key.conkey) = 1
            AND cardinality(foreign_key.confkey) = 1
            AND child_namespace.nspname = 'fitness'
            AND parent_namespace.nspname = 'fitness'
            AND child.relname NOT LIKE 'account_erasure_%'
            AND NOT fitness.account_erasure_relation_is_ownership_neutral(
              child.oid
            )
            AND NOT fitness.account_erasure_relation_is_ownership_neutral(
              parent.oid
            )
            AND EXISTS (
              SELECT 1
              FROM information_schema.columns AS owner_column
              WHERE owner_column.table_schema = 'fitness'
                AND owner_column.table_name = parent.relname
                AND owner_column.column_name = 'user_id'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM information_schema.columns AS direct_owner_column
              WHERE direct_owner_column.table_schema = 'fitness'
                AND direct_owner_column.table_name = child.relname
                AND direct_owner_column.column_name = 'user_id'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM pg_trigger
              JOIN pg_proc ON pg_proc.oid = pg_trigger.tgfoid
              WHERE pg_trigger.tgrelid = child.oid
                AND pg_proc.proname =
                  'reject_transitive_account_erasure_write'
                AND NOT pg_trigger.tgisinternal
            )
          ORDER BY child.relname, child_column.attname`,
    );

    expect(uncoveredRelationships).toEqual([]);
    await expect(
      context.db.execute(
        sql`INSERT INTO fitness.daily_metric_value (
              daily_metrics_id, metric_type_id, value
            )
            VALUES (
              ${deletingDailyMetricsId}::uuid,
              'account-erasure-blocked',
              2
            )`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
  });

  it("exposes status only with the opaque bearer token", async () => {
    await expect(findAccountErasureStatus(context.db, "wrong-token")).resolves.toBeNull();
    await expect(findAccountErasureStatus(context.db, statusToken)).resolves.toEqual(
      expect.objectContaining({
        retentionUntil: expect.any(String),
        id: requestId,
        message: null,
        requestedAt: expect.any(String),
        status: "pending",
      }),
    );
  });

  it("keeps retention verification claimable when the scheduler wakes after the public deadline", async () => {
    const requestedAt = new Date("2026-06-26T12:00:00.000Z");
    const deadline = new Date("2026-07-26T12:00:00.000Z");
    const beforeDeadline = new Date("2026-07-26T11:59:59.000Z");
    const afterDeadline = new Date("2026-07-26T12:00:00.001Z");
    const initiation = await initiateAccountErasure(
      context.db,
      deadlineUserId,
      async () => "encrypted-deadline-snapshot",
      async () => undefined,
      { now: requestedAt },
    );
    await expect(
      claimAccountErasureRequest(
        context.db,
        initiation.requestId,
        leaseOwner,
        60_000,
        beforeDeadline,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        completionDeadline: deadline,
        id: initiation.requestId,
      }),
    );
    await markAccountErasureWaiting(
      context.db,
      initiation.requestId,
      leaseOwner,
      deadline,
      "retention",
    );

    await expect(markOverdueAccountErasureRequests(context.db, afterDeadline)).resolves.toBe(1);
    await expect(
      listPendingAccountErasureRequests(context.db, 100, afterDeadline),
    ).resolves.toContainEqual({ id: initiation.requestId });
    await expect(
      claimAccountErasureRequest(
        context.db,
        initiation.requestId,
        leaseOwner,
        60_000,
        afterDeadline,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        id: initiation.requestId,
      }),
    );

    const [row] = await context.db.execute(
      sql`SELECT status, last_error, retry_at
          FROM fitness.account_erasure_request
          WHERE id = ${initiation.requestId}::uuid`,
    );
    expect(row).toEqual({
      last_error: "Account erasure exceeded its 30-day completion deadline; deletion continues",
      retry_at: null,
      status: "running",
    });
    await expect(
      findAccountErasureStatus(context.db, initiation.statusToken, afterDeadline),
    ).resolves.toEqual(
      expect.objectContaining({
        message:
          "Account deletion missed its 30-day deadline. Deletion remains active and automatic retries are continuing; support has been alerted.",
        status: "running",
      }),
    );
  });

  it("rejects completion before the request has transitioned to pseudonymous retention", async () => {
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (${incompleteErasureUserId}::uuid, 'Incomplete Erasure User', 'incomplete-erasure-1994@example.test')`,
    );
    const incompleteRequest = await initiateAccountErasure(
      context.db,
      incompleteErasureUserId,
      async () => "encrypted-incomplete-erasure-snapshot",
      async () => undefined,
    );
    await expect(
      claimAccountErasureRequest(context.db, incompleteRequest.requestId, leaseOwner, 60_000),
    ).resolves.toEqual(expect.objectContaining({ id: incompleteRequest.requestId }));
    await expect(
      completeAccountErasure(context.db, incompleteRequest.requestId, leaseOwner),
    ).rejects.toThrow(
      "not ready for pseudonymous completion",
    );
    const profiles = await context.db.execute(
      sql`SELECT id
          FROM fitness.user_profile
          WHERE id IN (${deletingUserId}::uuid, ${otherUserId}::uuid, ${incompleteErasureUserId}::uuid)
          ORDER BY id`,
    );
    expect(profiles).toHaveLength(3);
  });

  it("deletes the profile before final propagation and retains a pseudonymous request record", async () => {
    const scrubbedAt = new Date("2026-08-03T00:00:00.000Z");
    await context.db.execute(
      sql`UPDATE fitness.account_erasure_request
          SET
            phase_progress =
              '{"processor_erasure":{"remoteHandle":"pii-like-handle"}}'::jsonb,
            last_error = 'pii-like processor error'
          WHERE id = ${requestId}::uuid`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_checkpoint (
            request_id, phase, details
          )
          VALUES (
            ${requestId}::uuid,
            'processor_erasure',
            '{"remoteHandle":"pii-like-handle"}'::jsonb
          )
          ON CONFLICT (request_id, phase) DO UPDATE
            SET details = EXCLUDED.details`,
    );
    await erasePostgresAccount(context.db, requestId, deletingUserId);
    await deleteAccountErasureUserProfile(context.db, requestId, deletingUserId, leaseOwner);
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_checkpoint (
            request_id, phase, details
          )
          VALUES
            (${requestId}::uuid, 'consumer_drain', '{"quarantineHighWatermarks":[{"low":"4","offset":"12","partition":0}],"unexpected":"must-not-survive"}'::jsonb),
            (${requestId}::uuid, 'work_verification', '{"path":"pii-like-path"}'::jsonb),
            (${requestId}::uuid, 'consumer_drain_verification', '{"offset":"123"}'::jsonb),
            (${requestId}::uuid, 'stripe_erasure_verification', '{"customer":"pii-like-customer"}'::jsonb),
            (${requestId}::uuid, 'remote_revocation_verification', '{"email":"pii@example.test"}'::jsonb),
            (${requestId}::uuid, 'processor_erasure_verification', '{"contact":"pii@example.test"}'::jsonb),
            (${requestId}::uuid, 'postgres_profile_delete', ${JSON.stringify({ userId: deletingUserId })}::jsonb),
            (${requestId}::uuid, 'peerdb_drain_verification', '{"stage":"pii-like-stage"}'::jsonb),
            (${requestId}::uuid, 'clickhouse_verification', '{"part":"pii-like-part"}'::jsonb),
            (${requestId}::uuid, 'archive_verification', '{"key":"pii-like-key"}'::jsonb)`,
    );
    await scrubAccountErasureRequestPii(
      context.db,
      requestId,
      deletingUserId,
      leaseOwner,
      scrubbedAt,
    );
    await markAccountErasurePhaseCompleted(context.db, requestId, leaseOwner, "request_pii_scrub");
    const scrubbedRows = await context.db.execute(
      sql`SELECT
            request.user_id,
            request.encrypted_remote_snapshot,
            request.pii_scrubbed_at,
            request.phase_progress,
            request.last_error,
            jsonb_object_agg(checkpoint.phase, checkpoint.details) AS checkpoint_details
          FROM fitness.account_erasure_request AS request
          JOIN fitness.account_erasure_checkpoint AS checkpoint
            ON checkpoint.request_id = request.id
          WHERE request.id = ${requestId}::uuid
          GROUP BY request.id`,
    );
    expect(scrubbedRows).toEqual([
      {
        checkpoint_details: expect.objectContaining({
          consumer_drain: {
            quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
          },
          processor_erasure: null,
          remote_revocation_verification: null,
          request_pii_scrub: null,
        }),
        encrypted_remote_snapshot: null,
        last_error: null,
        phase_progress: {},
        pii_scrubbed_at: expect.any(String),
        user_id: null,
      },
    ]);
    await markAccountErasureWaiting(context.db, requestId, leaseOwner, scrubbedAt, "retention");
    await expect(
      listPendingAccountErasureRequests(context.db, 100, new Date(scrubbedAt.getTime() + 1)),
    ).resolves.toContainEqual({ id: requestId });
    await expect(
      claimAccountErasureRequest(
        context.db,
        requestId,
        leaseOwner,
        60_000,
        new Date(scrubbedAt.getTime() + 1),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        encryptedRemoteSnapshot: null,
        piiScrubbedAt: scrubbedAt,
        userId: null,
      }),
    );
    await markAccountErasurePhaseCompleted(
      context.db,
      requestId,
      leaseOwner,
      "retention_verification",
    );
    const completedAt = new Date("2026-10-01T12:34:00.000Z");
    await completeAccountErasure(context.db, requestId, leaseOwner, completedAt);
    await expect(findAccountErasureStatus(context.db, statusToken, completedAt)).resolves.toEqual(
      expect.objectContaining({
        completedAt: completedAt.toISOString(),
        deadlineMissed: true,
        message:
          "Account deletion completed after its 30-day deadline. Support was alerted to the delay.",
        status: "completed",
      }),
    );
    await expect(
      confirmAccountErasure(
        context.db,
        recoveryPreparationToken,
        {
          createEncryptedRemoteSnapshot: async () => {
            throw new Error("completed response recovery must not resnapshot");
          },
          findRestoreIntent: async (reference) =>
            restoreIntent?.keyId === reference.keyId &&
            restoreIntent.requestId === reference.requestId &&
            restoreIntent.userHash === reference.userHash
              ? restoreIntent
              : null,
          persistRestoreIntent: async () => {
            throw new Error("completed response recovery must not persist");
          },
        },
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        requestId,
        statusToken,
      }),
    );

    const rows = await context.db.execute(
      sql`SELECT
            request.user_id,
            request.status,
            request.completed_at IS NOT NULL AS completed,
            request.phase_progress,
            (SELECT count(*)::int
              FROM fitness.account_erasure_checkpoint AS checkpoint
              WHERE checkpoint.request_id = request.id) AS checkpoint_count,
            (SELECT count(*)::int
              FROM fitness.account_erasure_identity_fence AS identity_fence
              WHERE identity_fence.request_id = request.id) AS identity_fence_count,
            request.user_hash,
            request.user_hash_key_id,
            length(request.user_hash) AS hash_length
          FROM fitness.account_erasure_request AS request
          WHERE request.id = ${requestId}::uuid`,
    );
    const profiles = await context.db.execute(
      sql`SELECT id FROM fitness.user_profile WHERE id = ${deletingUserId}::uuid`,
    );

    expect(profiles).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        completed: true,
        checkpoint_count: 0,
        hash_length: 64,
        identity_fence_count: 0,
        phase_progress: {},
        status: "completed",
        user_id: null,
        user_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        user_hash_key_id: "test-v1",
      }),
    ]);

    await expect(
      context.db.execute(
        sql`INSERT INTO fitness.user_profile (id, name)
            VALUES (${deletingUserId}::uuid, 'Delayed callback recreation')`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
    await expect(
      isAccountErasureIdentityFenced(context.db, [
        {
          authProvider: "google",
          kind: "provider_account",
          providerAccountId: "deleted-google-account",
        },
      ]),
    ).resolves.toBe(false);
    await expect(
      withAccountErasureIdentityWriteFence(
        context.db,
        [
          {
            email: "delete-1994@example.test",
            kind: "email",
          },
          {
            authProvider: "google",
            kind: "provider_account",
            providerAccountId: "deleted-google-account",
          },
        ],
        async (transaction) => {
          await transaction.execute(
            sql`INSERT INTO fitness.user_profile (id, name, email)
                VALUES (
                  ${recreatedIdentityUserId}::uuid,
                  'Recreated After Completion',
                  'delete-1994@example.test'
                )`,
          );
          await transaction.execute(
            sql`INSERT INTO fitness.auth_account (
                  user_id, auth_provider, provider_account_id, email
                )
                VALUES (
                  ${recreatedIdentityUserId}::uuid,
                  'google',
                  'deleted-google-account',
                  'delete-login@example.test'
                )`,
          );
        },
      ),
    ).resolves.toBeUndefined();
  });
});
