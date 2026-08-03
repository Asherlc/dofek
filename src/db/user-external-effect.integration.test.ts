import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEncryptedAccountErasureSnapshot,
  decryptAccountErasureSnapshot,
} from "../account-erasure/remote-snapshot.ts";
import type { Provider } from "../providers/types.ts";
import { encryptCredentialValue } from "../security/credential-encryption.ts";
import { slackCredentialContext } from "../security/slack-credential-context.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { listUserExternalEffects, recordUserExternalEffect } from "./user-external-effect.ts";

const userId = "10000000-0000-4000-8000-000000001995";
const otherUserId = "20000000-0000-4000-8000-000000001995";
const externalEffectProvider: Provider = {
  id: "external-effect-provider",
  importOnly: true,
  name: "External Effect Provider",
  validate: () => null,
};

describe("user external effect provenance (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES
            (${userId}::uuid, 'External Effect User', 'effect@example.test'),
            (${otherUserId}::uuid, 'Other Effect User', 'other-effect@example.test')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.auth_account (
            user_id, auth_provider, provider_account_id, email
          )
          VALUES (
            ${userId}::uuid,
            'google',
            'external-effect-google',
            'auth-effect@example.test'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.user_password_credential (
            user_id, email, password_hash
          )
          VALUES (
            ${userId}::uuid,
            'password-effect@example.test',
            'test-password-hash'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.session (id, user_id, expires_at)
          VALUES (
            'external-effect-session',
            ${userId}::uuid,
            now() + interval '1 day'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES ('external-effect-provider', 'External Effect Provider')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider_connection (user_id, provider_id)
          VALUES (${userId}::uuid, 'external-effect-provider')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.webhook_subscription (
            user_id,
            provider_id,
            provider_name,
            subscription_external_id,
            verify_token,
            status
          )
          VALUES (
            ${userId}::uuid,
            'external-effect-provider',
            'External Effect Provider',
            'remote-subscription-1995',
            'failed-verify-token',
            'failed'
          )`,
    );
    const teamId = "T-SNAPSHOT-1995";
    const encryptedBotToken = await encryptCredentialValue(
      "xoxb-snapshot-1995",
      slackCredentialContext(teamId, "bot_token"),
    );
    const encryptedInstallation = await encryptCredentialValue(
      JSON.stringify({ team: { id: teamId } }),
      slackCredentialContext(teamId, "raw_installation"),
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_installation (
            team_id,
            bot_token,
            installer_slack_user_id,
            raw_installation
          )
          VALUES (
            ${teamId},
            ${encryptedBotToken},
            'U-SNAPSHOT-1995',
            to_jsonb(${encryptedInstallation}::text)
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_team_membership (
            team_id, user_id, slack_user_id
          )
          VALUES
            (${teamId}, ${userId}::uuid, 'U-SNAPSHOT-1995'),
            (${teamId}, ${otherUserId}::uuid, 'U-OTHER-1995')`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("records exact remote handles idempotently and includes them in the encrypted snapshot", async () => {
    const encryptedSnapshot = await context.db.transaction(async (transaction) => {
      await recordUserExternalEffect(transaction, {
        externalId: "cus_1995",
        resourceType: "customer",
        system: "stripe",
        userId,
      });
      await recordUserExternalEffect(transaction, {
        contactEmail: "support-contact@example.test",
        externalId: "ticket-1995",
        resourceType: "ticket",
        system: "zoho_desk",
        userId,
      });
      await recordUserExternalEffect(transaction, {
        contactEmail: "support-contact@example.test",
        externalId: "ticket-1995",
        resourceType: "ticket",
        system: "zoho_desk",
        userId,
      });
      return createEncryptedAccountErasureSnapshot(transaction, userId, [externalEffectProvider]);
    });

    await expect(listUserExternalEffects(context.db, userId)).resolves.toEqual([
      {
        contactEmail: null,
        externalId: "cus_1995",
        resourceType: "customer",
        system: "stripe",
      },
      {
        contactEmail: "support-contact@example.test",
        externalId: "ticket-1995",
        resourceType: "ticket",
        system: "zoho_desk",
      },
    ]);
    await expect(decryptAccountErasureSnapshot(encryptedSnapshot, userId)).resolves.toEqual(
      expect.objectContaining({
        authIdentities: [
          {
            authProvider: "google",
            email: "auth-effect@example.test",
            providerAccountId: "external-effect-google",
          },
        ],
        externalEffects: [
          {
            contactEmail: null,
            externalId: "cus_1995",
            resourceType: "customer",
            system: "stripe",
          },
          {
            contactEmail: "support-contact@example.test",
            externalId: "ticket-1995",
            resourceType: "ticket",
            system: "zoho_desk",
          },
        ],
        processorEmails: [
          "auth-effect@example.test",
          "effect@example.test",
          "password-effect@example.test",
        ],
        localIdentifiers: expect.objectContaining({
          sessionIds: ["external-effect-session"],
          userId,
        }),
        slackInstallations: [
          {
            botToken: "xoxb-snapshot-1995",
            memberCount: 2,
            slackUserId: "U-SNAPSHOT-1995",
            teamId: "T-SNAPSHOT-1995",
          },
        ],
        webhooks: [
          {
            providerId: "external-effect-provider",
            subscriptionExternalId: "remote-subscription-1995",
          },
        ],
      }),
    );
  });

  it("refuses to reattribute a remote resource to another user", async () => {
    const externalId = "reattribution-ticket-1995";
    await context.db.transaction((transaction) =>
      recordUserExternalEffect(transaction, {
        contactEmail: "support-contact@example.test",
        externalId,
        resourceType: "ticket",
        system: "zoho_desk",
        userId,
      }),
    );

    await expect(
      context.db.transaction((transaction) =>
        recordUserExternalEffect(transaction, {
          contactEmail: "support-contact@example.test",
          externalId,
          resourceType: "ticket",
          system: "zoho_desk",
          userId: otherUserId,
        }),
      ),
    ).rejects.toThrow("already attributed to another user");
  });
});
