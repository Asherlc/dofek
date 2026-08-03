import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initiateAccountErasure } from "../../../../src/db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import { FoodEntryRepository } from "./food-entry-repository.ts";
import { InMemoryPendingEntryStore } from "./pending-entry-store.ts";

const deletingUserId = "c0000000-0000-4000-8000-000000001994";
const inboundUserId = "d0000000-0000-4000-8000-000000001994";
const sharedUserId = "e0000000-0000-4000-8000-000000001994";
const slackTeamId = "T-FENCE-1994";
const slackUserId = "U-FENCE-1994";
const inboundTeamId = "T-INBOUND-FENCE-1994";
const inboundSlackUserId = "U-INBOUND-FENCE-1994";
const sharedSlackUserId = "U-SHARED-FENCE-1994";

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
             AND waiting_activity.query
               LIKE '%lock_and_reject_account_erasure_write%'
         ) AS waiting`,
      );
      if (result.rows[0]?.waiting) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("Inbound Slack write never waited on the account-erasure fence");
  } finally {
    await observer.end();
  }
}

function nutritionItem(): NutritionItemWithMeal {
  return {
    calories: 200,
    carbsG: 20,
    category: "other",
    fatG: 8,
    fiberG: 3,
    foodDescription: "1 serving",
    foodName: "Race test food",
    meal: "lunch",
    proteinG: 10,
    saturatedFatG: 2,
    sodiumMg: 100,
    sugarG: 5,
  };
}

describe("FoodEntryRepository inbound account-erasure fence (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES
            (
              ${deletingUserId}::uuid,
              'Slack fence user',
              'slack-fence-1994@example.test'
            ),
            (
              ${inboundUserId}::uuid,
              'Inbound Slack user',
              'slack-inbound-1994@example.test'
            ),
            (
              ${sharedUserId}::uuid,
              'Shared Slack user',
              'slack-shared-1994@example.test'
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.auth_account (
            user_id, auth_provider, provider_account_id, email
          )
          VALUES
            (
              ${deletingUserId}::uuid,
              'slack',
              ${slackUserId},
              'slack-fence-1994@example.test'
            ),
            (
              ${inboundUserId}::uuid,
              'slack',
              ${inboundSlackUserId},
              'slack-inbound-1994@example.test'
            ),
            (
              ${sharedUserId}::uuid,
              'slack',
              ${sharedSlackUserId},
              'slack-shared-1994@example.test'
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_installation (
            team_id, bot_token, installer_slack_user_id, raw_installation
          )
          VALUES
            (
              ${slackTeamId},
              'encrypted-test-token',
              ${slackUserId},
              '{}'::jsonb
            ),
            (
              ${inboundTeamId},
              'encrypted-inbound-test-token',
              ${inboundSlackUserId},
              '{}'::jsonb
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_team_membership (
            team_id, user_id, slack_user_id
          )
          VALUES
            (${slackTeamId}, ${deletingUserId}::uuid, ${slackUserId}),
            (${slackTeamId}, ${sharedUserId}::uuid, ${sharedSlackUserId})`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("persists a newly resolved inbound team membership before processing", async () => {
    const repository = new FoodEntryRepository(context.db, new InMemoryPendingEntryStore());
    let resolvedUserId: string | null = null;

    await repository.withInboundNutritionWriteFence(
      {
        slackClient: {
          users: {
            info: async () => ({
              user: {
                profile: { email: "slack-inbound-1994@example.test" },
                real_name: "Inbound Slack user",
                tz: "UTC",
              },
            }),
          },
        },
        slackUserId: inboundSlackUserId,
        teamId: inboundTeamId,
      },
      async ({ userId }) => {
        resolvedUserId = userId;
      },
    );

    expect(resolvedUserId).toBe(inboundUserId);
    await expect(
      context.db.execute(
        sql`SELECT user_id, slack_user_id
            FROM fitness.slack_team_membership
            WHERE team_id = ${inboundTeamId}`,
      ),
    ).resolves.toEqual([
      {
        slack_user_id: inboundSlackUserId,
        user_id: inboundUserId,
      },
    ]);
  });

  it("rechecks after concurrent erasure activation and prevents shared-team writes", async () => {
    let releaseSnapshot: () => void = () => {
      throw new Error("Snapshot release was not initialized");
    };
    let reportSnapshotStarted: () => void = () => {
      throw new Error("Snapshot start signal was not initialized");
    };
    const snapshotStarted = new Promise<void>((resolve) => {
      reportSnapshotStarted = resolve;
    });
    const snapshotReleased = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const initiation = initiateAccountErasure(
      context.db,
      deletingUserId,
      async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(
                hashtextextended(
                  'account-erasure-slack-team:' || ${slackTeamId},
                  0
                )
              )`,
        );
        reportSnapshotStarted();
        await snapshotReleased;
        return "encrypted-slack-fence-snapshot";
      },
      async () => undefined,
    );
    const initiationResult = initiation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    let coordinationError: unknown;
    try {
      await Promise.race([
        snapshotStarted,
        initiationResult.then((result) => {
          if (!result.ok) throw result.error;
        }),
      ]);
    } catch (error: unknown) {
      coordinationError = error;
    }
    if (coordinationError) {
      releaseSnapshot();
      await initiationResult;
      throw coordinationError;
    }

    const pendingStore = new InMemoryPendingEntryStore();
    const repository = new FoodEntryRepository(context.db, pendingStore);
    let processorRan = false;
    const inboundWrite = repository.withInboundNutritionWriteFence(
      {
        slackClient: {
          users: {
            info: async () => ({
              user: {
                profile: { email: "slack-fence-1994@example.test" },
                real_name: "Slack fence user",
                tz: "UTC",
              },
            }),
          },
        },
        slackUserId,
        teamId: slackTeamId,
      },
      async ({ repository: fencedRepository, userId }) => {
        processorRan = true;
        await fencedRepository.saveUnconfirmed(userId, "2026-07-26", [nutritionItem()], {
          channelId: "C-FENCE-1994",
          confirmationMessageTs: "confirmation-fence-1994",
          slackUserId,
          sourceMessageTs: "source-fence-1994",
          threadTs: "thread-fence-1994",
        });
      },
    );
    const inboundWriteResult = inboundWrite.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    let observerError: unknown;
    try {
      await waitForAdvisoryLockWait(context.connectionString);
      expect(processorRan).toBe(false);
    } catch (error: unknown) {
      observerError = error;
    } finally {
      releaseSnapshot();
    }

    const [completedInitiation, completedInboundWrite] = await Promise.all([
      initiationResult,
      inboundWriteResult,
    ]);
    if (observerError) throw observerError;
    expect(completedInitiation.ok).toBe(true);
    if (!completedInitiation.ok) throw completedInitiation.error;
    expect(completedInitiation.value).toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(completedInboundWrite.ok).toBe(false);
    if (completedInboundWrite.ok) {
      throw new Error("Inbound Slack write unexpectedly succeeded");
    }
    expect(completedInboundWrite.error).toHaveProperty(
      "message",
      expect.stringContaining("Account deletion is active for this user"),
    );
    expect(processorRan).toBe(false);
    await expect(
      pendingStore.findIdsByMessage("C-FENCE-1994", "confirmation-fence-1994"),
    ).resolves.toEqual([]);

    let sharedProcessorRan = false;
    await expect(
      repository.withInboundNutritionWriteFence(
        {
          slackClient: {
            users: {
              info: async () => ({
                user: {
                  profile: { email: "slack-shared-1994@example.test" },
                  real_name: "Shared Slack user",
                  tz: "UTC",
                },
              }),
            },
          },
          slackUserId: sharedSlackUserId,
          teamId: slackTeamId,
        },
        async () => {
          sharedProcessorRan = true;
        },
      ),
    ).rejects.toThrow("Account deletion is active for this user");
    expect(sharedProcessorRan).toBe(false);
  });
});
