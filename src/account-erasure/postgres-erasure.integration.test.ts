import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import { resolveUserExerciseWithProvenance } from "../db/exercise-provenance.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "../security/credential-encryption.ts";
import { slackCredentialContext } from "../security/slack-credential-context.ts";
import {
  assertPostgresAccountErasureComplete,
  assertPostgresAccountErasureCoverage,
  erasePostgresAccount,
  refreshPostgresAccountErasureWriteFences,
} from "./postgres-erasure.ts";
import {
  createEncryptedAccountErasureSnapshot,
  decryptAccountErasureSnapshot,
} from "./remote-snapshot.ts";

const deletingUserId = "10000000-0000-4000-8000-000000001994";
const otherUserId = "20000000-0000-4000-8000-000000001994";

async function beginErasure(context: TestContext, userId: string): Promise<string> {
  const request = await initiateAccountErasure(
    context.db,
    userId,
    async () => "encrypted-postgres-erasure-snapshot",
    async () => undefined,
  );
  return request.requestId;
}

describe("Postgres account-erasure ownership graph (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${deletingUserId}::uuid, 'Delete Postgres Graph'),
            (${otherUserId}::uuid, 'Keep Postgres Graph')`,
    );
    await context.db.execute(sql`CREATE SCHEMA IF NOT EXISTS analytics`);
    await context.db.execute(
      sql`CREATE TABLE analytics.erasure_owner_1994 (
            user_id uuid NOT NULL,
            owner_key text NOT NULL,
            PRIMARY KEY (user_id, owner_key)
          )`,
    );
    await context.db.execute(
      sql`CREATE TABLE analytics.erasure_middle_1994 (
            owner_user_id uuid NOT NULL,
            owner_key text NOT NULL,
            middle_id uuid NOT NULL UNIQUE,
            FOREIGN KEY (owner_user_id, owner_key)
              REFERENCES analytics.erasure_owner_1994 (user_id, owner_key)
          )`,
    );
    await context.db.execute(
      sql`CREATE TABLE analytics.erasure_leaf_1994 (
            id uuid PRIMARY KEY,
            middle_id uuid NOT NULL
              REFERENCES analytics.erasure_middle_1994 (middle_id)
          )`,
    );
    await refreshPostgresAccountErasureWriteFences(context.db);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("covers composite foreign keys and multi-hop ownership in managed schemas", async () => {
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();

    await context.db.execute(
      sql`INSERT INTO analytics.erasure_owner_1994 (user_id, owner_key)
          VALUES
            (${deletingUserId}::uuid, 'delete'),
            (${otherUserId}::uuid, 'keep')`,
    );
    await context.db.execute(
      sql`INSERT INTO analytics.erasure_middle_1994 (
            owner_user_id, owner_key, middle_id
          )
          VALUES
            (
              ${deletingUserId}::uuid,
              'delete',
              '31000000-0000-4000-8000-000000001994'::uuid
            ),
            (
              ${otherUserId}::uuid,
              'keep',
              '32000000-0000-4000-8000-000000001994'::uuid
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO analytics.erasure_leaf_1994 (id, middle_id)
          VALUES
            (
              '41000000-0000-4000-8000-000000001994'::uuid,
              '31000000-0000-4000-8000-000000001994'::uuid
            ),
            (
              '42000000-0000-4000-8000-000000001994'::uuid,
              '32000000-0000-4000-8000-000000001994'::uuid
            )`,
    );

    const requestId = await beginErasure(context, deletingUserId);

    await expect(
      context.db.execute(
        sql`INSERT INTO analytics.erasure_leaf_1994 (id, middle_id)
            VALUES (
              '43000000-0000-4000-8000-000000001994'::uuid,
              '31000000-0000-4000-8000-000000001994'::uuid
            )`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
    await expect(
      context.db.execute(
        sql`INSERT INTO analytics.erasure_leaf_1994 (id, middle_id)
            VALUES (
              '44000000-0000-4000-8000-000000001994'::uuid,
              '32000000-0000-4000-8000-000000001994'::uuid
            )`,
      ),
    ).resolves.toBeDefined();

    await erasePostgresAccount(context.db, requestId, deletingUserId);

    const rows = await context.db.execute(
      sql`SELECT
            (
              SELECT count(*)::integer
              FROM analytics.erasure_owner_1994
              WHERE user_id = ${deletingUserId}::uuid
            ) AS deleting_owners,
            (
              SELECT count(*)::integer
              FROM analytics.erasure_middle_1994
              WHERE owner_user_id = ${deletingUserId}::uuid
            ) AS deleting_middle_rows,
            (
              SELECT count(*)::integer
              FROM analytics.erasure_leaf_1994 AS leaf
              JOIN analytics.erasure_middle_1994 AS middle
                ON middle.middle_id = leaf.middle_id
              WHERE middle.owner_user_id = ${deletingUserId}::uuid
            ) AS deleting_leaf_rows,
            (
              SELECT count(*)::integer
              FROM analytics.erasure_owner_1994
              WHERE user_id = ${otherUserId}::uuid
            ) AS other_owners,
            (
              SELECT count(*)::integer
              FROM analytics.erasure_leaf_1994 AS leaf
              JOIN analytics.erasure_middle_1994 AS middle
                ON middle.middle_id = leaf.middle_id
              WHERE middle.owner_user_id = ${otherUserId}::uuid
            ) AS other_leaf_rows`,
    );
    expect(rows).toEqual([
      {
        deleting_leaf_rows: 0,
        deleting_middle_rows: 0,
        deleting_owners: 0,
        other_leaf_rows: 2,
        other_owners: 1,
      },
    ]);
  });
});

describe("personal experiment account erasure (integration)", () => {
  let context: TestContext;
  const experimentDeletingUserId = "13000000-0000-4000-8000-000000001994";
  const experimentOtherUserId = "23000000-0000-4000-8000-000000001994";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${experimentDeletingUserId}::uuid, 'Delete Experiment'),
            (${experimentOtherUserId}::uuid, 'Keep Experiment')`,
    );
    await refreshPostgresAccountErasureWriteFences(context.db);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("fences new experiments and deletes only the erasing user's experiments", async () => {
    await context.db.execute(
      sql`INSERT INTO fitness.personal_experiment (
            user_id,
            hypothesis,
            intervention,
            outcome_metric_id,
            baseline_days,
            intervention_days,
            start_date
          )
          VALUES
            (
              ${experimentDeletingUserId}::uuid,
              'Deleting hypothesis',
              'Deleting intervention',
              'resting_heart_rate',
              7,
              7,
              '2026-07-01'
            ),
            (
              ${experimentOtherUserId}::uuid,
              'Preserved hypothesis',
              'Preserved intervention',
              'resting_heart_rate',
              7,
              7,
              '2026-07-01'
            )`,
    );

    const requestId = await beginErasure(context, experimentDeletingUserId);

    await expect(
      context.db.execute(
        sql`INSERT INTO fitness.personal_experiment (
              user_id,
              hypothesis,
              intervention,
              outcome_metric_id,
              baseline_days,
              intervention_days,
              start_date
            )
            VALUES (
              ${experimentDeletingUserId}::uuid,
              'Blocked hypothesis',
              'Blocked intervention',
              'resting_heart_rate',
              7,
              7,
              '2026-07-02'
            )`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });

    await erasePostgresAccount(context.db, requestId, experimentDeletingUserId);

    const rows = await context.db.execute(
      sql`SELECT
            count(*) FILTER (
              WHERE user_id = ${experimentDeletingUserId}::uuid
            )::integer AS deleting_experiments,
            count(*) FILTER (
              WHERE user_id = ${experimentOtherUserId}::uuid
            )::integer AS other_experiments
          FROM fitness.personal_experiment`,
    );
    expect(rows).toEqual([{ deleting_experiments: 0, other_experiments: 1 }]);
  });
});

describe("processing history account erasure (integration)", () => {
  let context: TestContext;
  const processingDeletingUserId = "15000000-0000-4000-8000-000000001994";
  const processingOtherUserId = "25000000-0000-4000-8000-000000001994";
  const deletingOperationId = "35000000-0000-4000-8000-000000001994";
  const otherOperationId = "45000000-0000-4000-8000-000000001994";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${processingDeletingUserId}::uuid, 'Delete Processing History'),
            (${processingOtherUserId}::uuid, 'Keep Processing History')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_operation (
            id, user_id, provider_id, kind, external_correlation_key, dataset_keys
          )
          VALUES
            (
              ${deletingOperationId}::uuid,
              ${processingDeletingUserId}::uuid,
              'apple_health',
              'push_ingest',
              'delete-processing-history',
              ARRAY['recovery']::text[]
            ),
            (
              ${otherOperationId}::uuid,
              ${processingOtherUserId}::uuid,
              'apple_health',
              'push_ingest',
              'keep-processing-history',
              ARRAY['recovery']::text[]
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_stage_event (
            operation_id, stage, status, dataset_key, output_path, idempotency_key
          )
          VALUES
            (
              ${deletingOperationId}::uuid,
              'ingest',
              'succeeded',
              'recovery',
              'metric_stream',
              'delete-stage'
            ),
            (
              ${otherOperationId}::uuid,
              'ingest',
              'succeeded',
              'recovery',
              'metric_stream',
              'keep-stage'
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_operation_output (
            operation_id, dataset_key, output_path
          )
          VALUES
            (${deletingOperationId}::uuid, 'recovery', 'metric_stream'),
            (${otherOperationId}::uuid, 'recovery', 'metric_stream')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_flow_marker (
            operation_id, dataset_key, flow_name, batch_key, source_watermark
          )
          VALUES
            (
              ${deletingOperationId}::uuid,
              'recovery',
              'metric-stream-cdc',
              'delete-batch',
              '10'
            ),
            (
              ${otherOperationId}::uuid,
              'recovery',
              'metric-stream-cdc',
              'keep-batch',
              '20'
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_metric_stream_batch (
            operation_id, batch_id, dataset_keys, expected_event_count
          )
          VALUES
            (
              ${deletingOperationId}::uuid,
              'delete-metric-batch',
              ARRAY['recovery']::text[],
              1
            ),
            (
              ${otherOperationId}::uuid,
              'keep-metric-batch',
              ARRAY['recovery']::text[],
              1
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.processing_queue_outbox (
            operation_id, queue_name, job_id
          )
          VALUES
            (${deletingOperationId}::uuid, 'metric-stream', 'delete-job'),
            (${otherOperationId}::uuid, 'metric-stream', 'keep-job')`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("deletes append-only processing children through the operation cascade", async () => {
    const requestId = await beginErasure(context, processingDeletingUserId);

    await expect(
      erasePostgresAccount(context.db, requestId, processingDeletingUserId),
    ).resolves.toBeUndefined();

    const rows = await context.db.execute(
      sql`SELECT
            (
              SELECT count(*)::integer
              FROM fitness.processing_operation
              WHERE id = ${deletingOperationId}::uuid
            ) AS deleting_operations,
            (
              SELECT count(*)::integer
              FROM fitness.processing_stage_event
              WHERE operation_id = ${deletingOperationId}::uuid
            ) AS deleting_stage_events,
            (
              SELECT count(*)::integer
              FROM fitness.processing_operation_output
              WHERE operation_id = ${deletingOperationId}::uuid
            ) AS deleting_outputs,
            (
              SELECT count(*)::integer
              FROM fitness.processing_flow_marker
              WHERE operation_id = ${deletingOperationId}::uuid
            ) AS deleting_markers,
            (
              SELECT count(*)::integer
              FROM fitness.processing_metric_stream_batch
              WHERE operation_id = ${deletingOperationId}::uuid
            ) AS deleting_batches,
            (
              SELECT count(*)::integer
              FROM fitness.processing_queue_outbox
              WHERE operation_id = ${deletingOperationId}::uuid
            ) AS deleting_outbox_rows,
            (
              SELECT count(*)::integer
              FROM fitness.processing_operation
              WHERE id = ${otherOperationId}::uuid
            ) AS other_operations,
            (
              SELECT count(*)::integer
              FROM fitness.processing_stage_event
              WHERE operation_id = ${otherOperationId}::uuid
            ) AS other_stage_events,
            (
              SELECT count(*)::integer
              FROM fitness.processing_operation_output
              WHERE operation_id = ${otherOperationId}::uuid
            ) AS other_outputs,
            (
              SELECT count(*)::integer
              FROM fitness.processing_flow_marker
              WHERE operation_id = ${otherOperationId}::uuid
            ) AS other_markers,
            (
              SELECT count(*)::integer
              FROM fitness.processing_metric_stream_batch
              WHERE operation_id = ${otherOperationId}::uuid
            ) AS other_batches,
            (
              SELECT count(*)::integer
              FROM fitness.processing_queue_outbox
              WHERE operation_id = ${otherOperationId}::uuid
            ) AS other_outbox_rows`,
    );
    expect(rows).toEqual([
      {
        deleting_batches: 0,
        deleting_markers: 0,
        deleting_operations: 0,
        deleting_outbox_rows: 0,
        deleting_outputs: 0,
        deleting_stage_events: 0,
        other_batches: 1,
        other_markers: 1,
        other_operations: 1,
        other_outbox_rows: 1,
        other_outputs: 1,
        other_stage_events: 1,
      },
    ]);
  });
});

describe("Postgres account-erasure schema drift (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`CREATE SCHEMA IF NOT EXISTS analytics`);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("allows shared metric-stream rebuild task state", async () => {
    await context.db.execute(
      sql`CREATE TABLE fitness.metric_stream_rebuild_task (
            id bigint PRIMARY KEY
          )`,
    );

    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
  });

  it("fails closed when a base table has no ownership or shared-system policy", async () => {
    await context.db.execute(
      sql`CREATE TABLE analytics.unclassified_erasure_drift_1994 (
            id uuid PRIMARY KEY
          )`,
    );
    await expect(assertPostgresAccountErasureCoverage(context.db)).rejects.toThrow(
      "analytics.unclassified_erasure_drift_1994",
    );
  });
});

describe("exercise provenance account erasure (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${deletingUserId}::uuid, 'Delete Exercise Source'),
            (${otherUserId}::uuid, 'Keep Exercise Source')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES
            ('strong-csv', 'Strong'),
            ('whoop', 'WHOOP')
          ON CONFLICT (id) DO NOTHING`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("removes only the deleting user's attribution and orphaned catalog rows", async () => {
    const sharedExerciseId = await resolveUserExerciseWithProvenance(context.db, {
      equipment: "Barbell",
      exerciseType: "STRENGTH",
      muscleGroups: ["CHEST"],
      name: "Shared Bench",
      providerExerciseId: "SHARED_BENCH",
      providerExerciseName: "Shared Bench",
      providerId: "whoop",
      userId: deletingUserId,
    });
    await resolveUserExerciseWithProvenance(context.db, {
      equipment: "Barbell",
      exerciseType: "STRENGTH",
      muscleGroups: ["CHEST"],
      name: "Shared Bench",
      providerExerciseId: "SHARED_BENCH",
      providerExerciseName: "Shared Bench",
      providerId: "whoop",
      userId: otherUserId,
    });
    const privateExerciseId = await resolveUserExerciseWithProvenance(context.db, {
      equipment: null,
      exerciseType: "STRENGTH",
      muscleGroups: null,
      name: "Delete My Private Exercise",
      providerExerciseId: null,
      providerExerciseName: "Delete My Private Exercise",
      providerId: "strong-csv",
      userId: deletingUserId,
    });
    const systemExerciseId = await resolveUserExerciseWithProvenance(context.db, {
      equipment: "Barbell",
      exerciseType: "STRENGTH",
      muscleGroups: ["LEGS"],
      name: "System Squat",
      providerExerciseId: "SYSTEM_SQUAT",
      providerExerciseName: "System Squat",
      providerId: "whoop",
      userId: deletingUserId,
    });
    await context.db.execute(
      sql`INSERT INTO fitness.exercise_source (
            exercise_id, source_kind, user_id, provider_id
          )
          VALUES (
            ${systemExerciseId}::uuid,
            'system',
            NULL,
            NULL
          )`,
    );

    const requestId = await beginErasure(context, deletingUserId);
    await erasePostgresAccount(context.db, requestId, deletingUserId);

    const rows = await context.db.execute(
      sql`SELECT
            EXISTS (
              SELECT 1 FROM fitness.exercise
              WHERE id = ${sharedExerciseId}::uuid
            ) AS shared_exercise_exists,
            EXISTS (
              SELECT 1 FROM fitness.exercise
              WHERE id = ${privateExerciseId}::uuid
            ) AS private_exercise_exists,
            EXISTS (
              SELECT 1 FROM fitness.exercise
              WHERE id = ${systemExerciseId}::uuid
            ) AS system_exercise_exists,
            (
              SELECT count(*)::integer
              FROM fitness.exercise_source
              WHERE exercise_id = ${sharedExerciseId}::uuid
                AND user_id = ${otherUserId}::uuid
            ) AS other_shared_sources,
            (
              SELECT count(*)::integer
              FROM fitness.exercise_source
              WHERE user_id = ${deletingUserId}::uuid
            ) AS deleting_sources`,
    );
    expect(rows).toEqual([
      {
        deleting_sources: 0,
        other_shared_sources: 1,
        private_exercise_exists: false,
        shared_exercise_exists: true,
        system_exercise_exists: true,
      },
    ]);
  });

  it("rolls back exercise and alias creation when the provenance fence rejects", async () => {
    await expect(
      resolveUserExerciseWithProvenance(context.db, {
        equipment: "Cable",
        exerciseType: "STRENGTH",
        muscleGroups: ["BACK"],
        name: "Must Roll Back",
        providerExerciseId: "MUST_ROLL_BACK",
        providerExerciseName: "Must Roll Back",
        providerId: "whoop",
        userId: deletingUserId,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
    await expect(
      context.db.execute(sql`SELECT id FROM fitness.exercise WHERE name = 'Must Roll Back'`),
    ).resolves.toEqual([]);
    await expect(
      context.db.execute(
        sql`SELECT id
            FROM fitness.exercise_alias
            WHERE provider_exercise_name = 'Must Roll Back'`,
      ),
    ).resolves.toEqual([]);
  });
});

describe("Slack team membership account erasure (integration)", () => {
  let context: TestContext;
  const sharedTeamId = "T-SHARED-ERASURE-1994";
  const soleTeamId = "T-SOLE-ERASURE-1994";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${deletingUserId}::uuid, 'Delete Slack Member'),
            (${otherUserId}::uuid, 'Keep Slack Member')`,
    );
    for (const teamId of [sharedTeamId, soleTeamId]) {
      const botToken = await encryptCredentialValue(
        `xoxb-${teamId}`,
        slackCredentialContext(teamId, "bot_token"),
      );
      const rawInstallation = await encryptCredentialValue(
        JSON.stringify({
          authed_user: {
            email: "delete-slack@example.test",
            id: "U-DELETE-1994",
          },
          team: { id: teamId },
        }),
        slackCredentialContext(teamId, "raw_installation"),
      );
      await context.db.execute(
        sql`INSERT INTO fitness.slack_installation (
              team_id,
              team_name,
              bot_token,
              bot_id,
              bot_user_id,
              app_id,
              installer_slack_user_id,
              raw_installation
            )
            VALUES (
              ${teamId},
              'Erasure workspace',
              ${botToken},
              'B-1994',
              'U-BOT-1994',
              'A-1994',
              'U-DELETE-1994',
              to_jsonb(${rawInstallation}::text)
            )`,
      );
    }
    await context.db.execute(
      sql`INSERT INTO fitness.slack_team_membership (
            team_id, user_id, slack_user_id
          )
          VALUES
            (
              ${sharedTeamId},
              ${deletingUserId}::uuid,
              'U-DELETE-1994'
            ),
            (
              ${sharedTeamId},
              ${otherUserId}::uuid,
              'U-KEEP-1994'
            ),
            (
              ${soleTeamId},
              ${deletingUserId}::uuid,
              'U-DELETE-1994'
            )`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("preserves and scrubs shared installs while deleting sole-member installs", async () => {
    const requestId = await beginErasure(context, deletingUserId);
    const otherMemberSnapshot = await context.db.transaction((transaction) =>
      createEncryptedAccountErasureSnapshot(transaction, otherUserId),
    );
    await expect(decryptAccountErasureSnapshot(otherMemberSnapshot, otherUserId)).resolves.toEqual(
      expect.objectContaining({
        slackInstallations: [
          expect.objectContaining({
            memberCount: 1,
            teamId: sharedTeamId,
          }),
        ],
      }),
    );

    await expect(
      context.db.execute(
        sql`UPDATE fitness.slack_installation
            SET team_name = 'Concurrent mutation'
            WHERE team_id = ${sharedTeamId}`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
    await expect(
      context.db.execute(
        sql`DELETE FROM fitness.slack_team_membership
            WHERE team_id = ${sharedTeamId}
              AND user_id = ${otherUserId}::uuid`,
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });
    await expect(
      context.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT set_config(
                'dofek.account_erasure_request_id',
                ${requestId},
                true
              )`,
        );
        await transaction.execute(
          sql`DELETE FROM fitness.slack_team_membership
              WHERE team_id = ${sharedTeamId}
                AND user_id = ${otherUserId}::uuid`,
        );
        throw new Error("Slack mutation unexpectedly bypassed the erasure fence");
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("Account erasure is active"),
      }),
    });

    await erasePostgresAccount(context.db, requestId, deletingUserId);

    const rows = await context.db.execute(
      sql`SELECT
            installation.team_id,
            installation.installer_slack_user_id,
            installation.raw_installation,
            membership.user_id,
            membership.slack_user_id
          FROM fitness.slack_installation AS installation
          JOIN fitness.slack_team_membership AS membership
            ON membership.team_id = installation.team_id
          WHERE installation.team_id IN (${sharedTeamId}, ${soleTeamId})
          ORDER BY installation.team_id, membership.user_id`,
    );
    expect(rows).toHaveLength(1);
    const row = z
      .object({
        installer_slack_user_id: z.string(),
        raw_installation: z.string(),
        slack_user_id: z.string(),
        team_id: z.string(),
        user_id: z.uuid(),
      })
      .parse(rows[0]);
    expect(row).toEqual(
      expect.objectContaining({
        installer_slack_user_id: "U-KEEP-1994",
        slack_user_id: "U-KEEP-1994",
        team_id: sharedTeamId,
        user_id: otherUserId,
      }),
    );
    const rawInstallation = await decryptCredentialValue(
      row.raw_installation,
      slackCredentialContext(sharedTeamId, "raw_installation"),
    );
    expect(JSON.parse(rawInstallation)).toEqual(
      expect.objectContaining({
        team: { id: sharedTeamId, name: "Erasure workspace" },
        user: { id: "U-KEEP-1994" },
      }),
    );
    expect(rawInstallation).not.toContain("U-DELETE-1994");
    expect(rawInstallation).not.toContain("delete-slack@example.test");

    await expect(
      context.db.execute(
        sql`SELECT team_id
            FROM fitness.slack_installation
            WHERE team_id = ${soleTeamId}`,
      ),
    ).resolves.toEqual([]);
  });
});

describe("legacy Postgres account-erasure stores (integration)", () => {
  let context: TestContext;
  const legacyDeletingUserId = "61000000-0000-4000-8000-000000001994";
  const legacyOtherUserId = "62000000-0000-4000-8000-000000001994";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${legacyDeletingUserId}::uuid, 'Delete Legacy Stores'),
            (${legacyOtherUserId}::uuid, 'Keep Legacy Stores')`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("erases legacy aggregate rows and resets matching backfill cursors", async () => {
    await context.db.execute(
      sql`INSERT INTO fitness.cagg_metric_daily (bucket, user_id, total_samples)
          VALUES
            ('2026-07-01T00:00:00.000Z', ${legacyDeletingUserId}::uuid, 10),
            ('2026-07-01T00:00:00.000Z', ${legacyOtherUserId}::uuid, 20)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.cagg_metric_weekly (bucket, user_id, total_samples)
          VALUES
            ('2026-06-29T00:00:00.000Z', ${legacyDeletingUserId}::uuid, 30),
            ('2026-06-29T00:00:00.000Z', ${legacyOtherUserId}::uuid, 40)`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.cagg_sensor_daily (
            bucket, user_id, channel, sample_count
          )
          VALUES
            (
              '2026-07-01T00:00:00.000Z',
              ${legacyDeletingUserId}::uuid,
              'heart_rate',
              10
            ),
            (
              '2026-07-01T00:00:00.000Z',
              ${legacyOtherUserId}::uuid,
              'heart_rate',
              20
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.cagg_sensor_weekly (
            bucket, user_id, channel, sample_count
          )
          VALUES
            (
              '2026-06-29T00:00:00.000Z',
              ${legacyDeletingUserId}::uuid,
              'heart_rate',
              30
            ),
            (
              '2026-06-29T00:00:00.000Z',
              ${legacyOtherUserId}::uuid,
              'heart_rate',
              40
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider_connection_backfill_progress (
            source_table,
            last_user_id,
            last_provider_id,
            rows_inserted,
            completed_at
          )
          VALUES
            (
              'legacy-delete-cursor',
              ${legacyDeletingUserId}::uuid,
              'whoop',
              10,
              now()
            ),
            (
              'legacy-keep-cursor',
              ${legacyOtherUserId}::uuid,
              'garmin',
              20,
              now()
            )`,
    );

    const requestId = await beginErasure(context, legacyDeletingUserId);
    await erasePostgresAccount(context.db, requestId, legacyDeletingUserId);

    const aggregateRows = await context.db.execute(
      sql`SELECT
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_3
              WHERE user_id = ${legacyDeletingUserId}::uuid
            ) AS deleting_metric_daily,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_4
              WHERE user_id = ${legacyDeletingUserId}::uuid
            ) AS deleting_metric_weekly,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_10
              WHERE user_id = ${legacyDeletingUserId}::uuid
            ) AS deleting_sensor_daily,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_11
              WHERE user_id = ${legacyDeletingUserId}::uuid
            ) AS deleting_sensor_weekly,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_3
              WHERE user_id = ${legacyOtherUserId}::uuid
            ) AS other_metric_daily,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_4
              WHERE user_id = ${legacyOtherUserId}::uuid
            ) AS other_metric_weekly,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_10
              WHERE user_id = ${legacyOtherUserId}::uuid
            ) AS other_sensor_daily,
            (
              SELECT count(*)::integer
              FROM _timescaledb_internal._materialized_hypertable_11
              WHERE user_id = ${legacyOtherUserId}::uuid
            ) AS other_sensor_weekly`,
    );
    expect(aggregateRows).toEqual([
      {
        deleting_metric_daily: 0,
        deleting_metric_weekly: 0,
        deleting_sensor_daily: 0,
        deleting_sensor_weekly: 0,
        other_metric_daily: 1,
        other_metric_weekly: 1,
        other_sensor_daily: 1,
        other_sensor_weekly: 1,
      },
    ]);
    await expect(
      context.db.execute(
        sql`SELECT source_table, last_user_id, last_provider_id
            FROM fitness.provider_connection_backfill_progress
            ORDER BY source_table`,
      ),
    ).resolves.toEqual([
      {
        last_provider_id: null,
        last_user_id: null,
        source_table: "legacy-delete-cursor",
      },
      {
        last_provider_id: "garmin",
        last_user_id: legacyOtherUserId,
        source_table: "legacy-keep-cursor",
      },
    ]);

    await context.db.execute(
      sql`DELETE FROM fitness.user_profile
          WHERE id = ${legacyDeletingUserId}::uuid`,
    );
    await context.db.execute(
      sql`INSERT INTO _timescaledb_internal._materialized_hypertable_3 (
            bucket, user_id, total_samples
          )
          VALUES (
            '2026-07-02T00:00:00.000Z',
            ${legacyDeletingUserId}::uuid,
            1
          )`,
    );
    await expect(
      assertPostgresAccountErasureComplete(context.db, legacyDeletingUserId),
    ).rejects.toThrow("legacy aggregate");

    await context.db.execute(
      sql`DELETE FROM _timescaledb_internal._materialized_hypertable_3
          WHERE user_id = ${legacyDeletingUserId}::uuid`,
    );
    await context.db.execute(
      sql`UPDATE fitness.provider_connection_backfill_progress
          SET
            last_user_id = ${legacyDeletingUserId}::uuid,
            last_provider_id = 'whoop'
          WHERE source_table = 'legacy-delete-cursor'`,
    );
    await expect(
      assertPostgresAccountErasureComplete(context.db, legacyDeletingUserId),
    ).rejects.toThrow("backfill cursor");
  });
});

describe("concurrent shared-exercise account erasure (integration)", () => {
  let context: TestContext;
  const firstUserId = "71000000-0000-4000-8000-000000001994";
  const secondUserId = "72000000-0000-4000-8000-000000001994";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${firstUserId}::uuid, 'Delete Shared Exercise One'),
            (${secondUserId}::uuid, 'Delete Shared Exercise Two')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES ('whoop', 'WHOOP')
          ON CONFLICT (id) DO NOTHING`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("completes both active erasures and removes the orphaned shared catalog", async () => {
    const exerciseId = await resolveUserExerciseWithProvenance(context.db, {
      equipment: "Barbell",
      exerciseType: "STRENGTH",
      muscleGroups: ["CHEST"],
      name: "Concurrent Shared Bench",
      providerExerciseId: "CONCURRENT_SHARED_BENCH",
      providerExerciseName: "Concurrent Shared Bench",
      providerId: "whoop",
      userId: firstUserId,
    });
    await resolveUserExerciseWithProvenance(context.db, {
      equipment: "Barbell",
      exerciseType: "STRENGTH",
      muscleGroups: ["CHEST"],
      name: "Concurrent Shared Bench",
      providerExerciseId: "CONCURRENT_SHARED_BENCH",
      providerExerciseName: "Concurrent Shared Bench",
      providerId: "whoop",
      userId: secondUserId,
    });
    const firstRequestId = await beginErasure(context, firstUserId);
    const secondRequestId = await beginErasure(context, secondUserId);

    const results = await Promise.allSettled([
      erasePostgresAccount(context.db, firstRequestId, firstUserId),
      erasePostgresAccount(context.db, secondRequestId, secondUserId),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    await expect(
      context.db.execute(
        sql`SELECT
              (
                SELECT count(*)::integer
                FROM fitness.exercise
                WHERE id = ${exerciseId}::uuid
              ) AS exercises,
              (
                SELECT count(*)::integer
                FROM fitness.exercise_source
                WHERE exercise_id = ${exerciseId}::uuid
              ) AS sources,
              (
                SELECT count(*)::integer
                FROM fitness.exercise_alias
                WHERE exercise_id = ${exerciseId}::uuid
              ) AS aliases`,
      ),
    ).resolves.toEqual([{ aliases: 0, exercises: 0, sources: 0 }]);
  });
});

describe("concurrent shared-Slack-team account erasure (integration)", () => {
  let context: TestContext;
  const firstUserId = "81000000-0000-4000-8000-000000001994";
  const secondUserId = "82000000-0000-4000-8000-000000001994";
  const teamId = "T-CONCURRENT-ERASURE-1994";

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${firstUserId}::uuid, 'Delete Slack Team One'),
            (${secondUserId}::uuid, 'Delete Slack Team Two')`,
    );
    const botToken = await encryptCredentialValue(
      "xoxb-concurrent-erasure",
      slackCredentialContext(teamId, "bot_token"),
    );
    const rawInstallation = await encryptCredentialValue(
      JSON.stringify({
        team: { id: teamId },
        user: { id: "U-CONCURRENT-ONE" },
      }),
      slackCredentialContext(teamId, "raw_installation"),
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_installation (
            team_id,
            team_name,
            bot_token,
            installer_slack_user_id,
            raw_installation
          )
          VALUES (
            ${teamId},
            'Concurrent erasure workspace',
            ${botToken},
            'U-CONCURRENT-ONE',
            to_jsonb(${rawInstallation}::text)
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_team_membership (
            team_id, user_id, slack_user_id
          )
          VALUES
            (${teamId}, ${firstUserId}::uuid, 'U-CONCURRENT-ONE'),
            (${teamId}, ${secondUserId}::uuid, 'U-CONCURRENT-TWO')`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("allows both active requests to remove their memberships and the shared installation", async () => {
    const firstRequestId = await beginErasure(context, firstUserId);
    const secondRequestId = await beginErasure(context, secondUserId);

    const results = await Promise.allSettled([
      erasePostgresAccount(context.db, firstRequestId, firstUserId),
      erasePostgresAccount(context.db, secondRequestId, secondUserId),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    await expect(
      context.db.execute(
        sql`SELECT
              (
                SELECT count(*)::integer
                FROM fitness.slack_installation
                WHERE team_id = ${teamId}
              ) AS installations,
              (
                SELECT count(*)::integer
                FROM fitness.slack_team_membership
                WHERE team_id = ${teamId}
              ) AS memberships`,
      ),
    ).resolves.toEqual([{ installations: 0, memberships: 0 }]);
  });
});
