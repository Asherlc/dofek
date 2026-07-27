import { randomUUID } from "node:crypto";
import type { ConnectionOptions } from "bullmq";
import { Queue, QueueEvents } from "bullmq";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import { findAccountErasureStatus, initiateAccountErasure } from "../db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { dispatchAccountErasureOutbox } from "./account-erasure-outbox.ts";
import { createAccountErasureWorker } from "./account-erasure-worker.ts";
import {
  ACCOUNT_ERASURE_ACTIVE_PHASES,
  type AccountErasurePhase,
} from "./process-account-erasure-job.ts";
import type {
  AccountErasurePhaseExecution,
  AccountErasurePhaseRunner,
} from "./process-account-erasure-request.ts";
import { ACCOUNT_ERASURE_QUEUE, type AccountErasureJobData, getRedisConnection } from "./queues.ts";

describe("account erasure outbox and worker (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("delivers a durable outbox request through BullMQ to completion", async () => {
    const userId = randomUUID();
    const requestedAt = new Date(Date.now() - 29 * 24 * 60 * 60 * 1_000 - 60_000);
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (
            ${userId}::uuid,
            'Worker-backed erasure',
            'worker-backed-erasure@example.test'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.user_settings (user_id, key, value)
          VALUES (${userId}::uuid, 'worker-backed-erasure', 'true'::jsonb)`,
    );
    const accepted = await initiateAccountErasure(
      context.db,
      userId,
      async () => "encrypted-worker-backed-snapshot",
      async () => {},
      { now: requestedAt },
    );

    const phaseRuns: AccountErasurePhase[] = [];
    const phaseRunner: AccountErasurePhaseRunner = {
      async runPhase(
        phase: AccountErasurePhase,
        execution: AccountErasurePhaseExecution,
      ): Promise<Record<string, unknown> | null> {
        phaseRuns.push(phase);
        if (phase === "postgres_erasure") {
          await erasePostgresAccount(context.db, execution.request.id, userId);
          return null;
        }
        if (phase === "postgres_profile_delete") {
          return execution.deleteProfile();
        }
        if (phase === "request_pii_scrub") {
          await execution.scrubPii();
        }
        return null;
      },
    };
    const connection: ConnectionOptions = getRedisConnection();
    const prefix = `account-erasure-integration-${randomUUID()}`;
    const queueOptions = { connection, prefix };
    const queue = new Queue<AccountErasureJobData>(ACCOUNT_ERASURE_QUEUE, queueOptions);
    const queueEvents = new QueueEvents(ACCOUNT_ERASURE_QUEUE, queueOptions);
    const worker = createAccountErasureWorker(
      context.db,
      `account-erasure-integration:${randomUUID()}`,
      phaseRunner,
      queueOptions,
    );

    try {
      await Promise.all([
        queue.waitUntilReady(),
        queueEvents.waitUntilReady(),
        worker.waitUntilReady(),
      ]);
      await expect(dispatchAccountErasureOutbox(context.db, queue)).resolves.toBe(1);
      const job = await queue.getJob(accepted.requestId);
      if (!job) {
        throw new Error("Account erasure outbox did not create the BullMQ job");
      }
      const completed = job.waitUntilFinished(queueEvents, 30_000);
      void worker.run();

      await expect(completed).resolves.toEqual({ status: "completed" });
      expect(phaseRuns).toEqual(ACCOUNT_ERASURE_ACTIVE_PHASES);
      await expect(findAccountErasureStatus(context.db, accepted.statusToken)).resolves.toEqual(
        expect.objectContaining({
          currentPhase: "completed",
          message: null,
          status: "completed",
        }),
      );

      const rows = await context.db.execute(
        sql`SELECT
              request.user_id,
              request.encrypted_remote_snapshot,
              request.completed_at IS NOT NULL AS completed,
              outbox.status AS outbox_status,
              EXISTS (
                SELECT 1 FROM fitness.user_profile WHERE id = ${userId}::uuid
              ) AS profile_exists,
              EXISTS (
                SELECT 1 FROM fitness.user_settings WHERE user_id = ${userId}::uuid
              ) AS settings_exist
            FROM fitness.account_erasure_request AS request
            JOIN fitness.account_erasure_outbox AS outbox
              ON outbox.request_id = request.id
            WHERE request.id = ${accepted.requestId}::uuid`,
      );
      expect(rows).toEqual([
        {
          completed: true,
          encrypted_remote_snapshot: null,
          outbox_status: "dispatched",
          profile_exists: false,
          settings_exist: false,
          user_id: null,
        },
      ]);
    } finally {
      await worker.close();
      await queueEvents.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 120_000);
});
