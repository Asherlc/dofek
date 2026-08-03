import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { SlackInstallationRepository } from "./slack-installation-repository.ts";

const firstUserId = "10000000-0000-4000-8000-000000001994";
const secondUserId = "20000000-0000-4000-8000-000000001994";

function installationInput(teamId: string) {
  return {
    appId: "A-1994",
    botId: "B-1994",
    botToken: `xoxb-${teamId}`,
    botUserId: "U-BOT-1994",
    installerSlackUserId: "U-INSTALLER-1994",
    rawInstallation: {
      appId: "A-1994",
      bot: { token: `xoxb-${teamId}`, userId: "U-BOT-1994" },
      team: { id: teamId, name: "Account erasure test" },
      user: { id: "U-INSTALLER-1994" },
    },
    teamId,
    teamName: "Account erasure test",
  };
}

describe("SlackInstallationRepository membership (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${firstUserId}::uuid, 'First Slack member'),
            (${secondUserId}::uuid, 'Second Slack member')`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("atomically persists a shared installation and each Dofek member", async () => {
    const repository = new SlackInstallationRepository(context.db);
    const shared = installationInput("T-SHARED-1994");

    await repository.upsertMemberInstallation({
      ...shared,
      slackUserId: "U-FIRST-1994",
      userId: firstUserId,
    });
    await repository.upsertMemberInstallation({
      ...shared,
      installerSlackUserId: "U-SECOND-1994",
      slackUserId: "U-SECOND-1994",
      userId: secondUserId,
    });

    await expect(
      context.db.execute(
        sql`SELECT user_id, slack_user_id
            FROM fitness.slack_team_membership
            WHERE team_id = ${shared.teamId}
            ORDER BY user_id`,
      ),
    ).resolves.toEqual([
      { slack_user_id: "U-FIRST-1994", user_id: firstUserId },
      { slack_user_id: "U-SECOND-1994", user_id: secondUserId },
    ]);
  });

  it("adds an inbound Slack user to an existing shared installation", async () => {
    const repository = new SlackInstallationRepository(context.db);
    const shared = installationInput("T-INBOUND-1994");

    await repository.upsertMemberInstallation({
      ...shared,
      slackUserId: "U-FIRST-INBOUND-1994",
      userId: firstUserId,
    });
    await repository.upsertTeamMembership({
      slackUserId: "U-SECOND-INBOUND-1994",
      teamId: shared.teamId,
      userId: secondUserId,
    });

    await expect(
      context.db.execute(
        sql`SELECT user_id, slack_user_id
            FROM fitness.slack_team_membership
            WHERE team_id = ${shared.teamId}
            ORDER BY user_id`,
      ),
    ).resolves.toEqual([
      { slack_user_id: "U-FIRST-INBOUND-1994", user_id: firstUserId },
      { slack_user_id: "U-SECOND-INBOUND-1994", user_id: secondUserId },
    ]);
  });

  it("keeps token-only Socket Mode fences safe when no OAuth installation exists", async () => {
    const repository = new SlackInstallationRepository(context.db);
    const teamId = "T-TOKEN-ONLY-1994";

    await expect(
      repository.upsertTeamMembership({
        slackUserId: "U-TOKEN-ONLY-1994",
        teamId,
        userId: secondUserId,
      }),
    ).resolves.toBeUndefined();

    await expect(
      context.db.execute(
        sql`SELECT team_id
            FROM fitness.slack_team_membership
            WHERE team_id = ${teamId}`,
      ),
    ).resolves.toEqual([]);
  });

  it("atomically reassigns an inbound Slack identity to its current Dofek user", async () => {
    const repository = new SlackInstallationRepository(context.db);
    const shared = installationInput("T-REASSIGN-1994");

    await repository.upsertMemberInstallation({
      ...shared,
      slackUserId: "U-REASSIGN-1994",
      userId: firstUserId,
    });
    await repository.upsertTeamMembership({
      slackUserId: "U-REASSIGN-1994",
      teamId: shared.teamId,
      userId: secondUserId,
    });

    await expect(
      context.db.execute(
        sql`SELECT user_id, slack_user_id
            FROM fitness.slack_team_membership
            WHERE team_id = ${shared.teamId}`,
      ),
    ).resolves.toEqual([{ slack_user_id: "U-REASSIGN-1994", user_id: secondUserId }]);
  });

  it("rolls back the installation when membership cannot be persisted", async () => {
    const repository = new SlackInstallationRepository(context.db);
    const teamId = "T-ROLLBACK-1994";

    await expect(
      repository.upsertMemberInstallation({
        ...installationInput(teamId),
        slackUserId: "U-MISSING-1994",
        userId: "30000000-0000-4000-8000-000000001994",
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23503" }),
    });

    await expect(
      context.db.execute(
        sql`SELECT team_id
            FROM fitness.slack_installation
            WHERE team_id = ${teamId}`,
      ),
    ).resolves.toEqual([]);
  });
});
