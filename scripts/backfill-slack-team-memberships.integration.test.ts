import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../src/db/test-helpers.ts";
import { encryptCredentialValue } from "../src/security/credential-encryption.ts";
import { slackCredentialContext } from "../src/security/slack-credential-context.ts";
import { failOnUnhandledExternalRequest } from "../src/test/msw.ts";
import { backfillSlackTeamMemberships } from "./backfill-slack-team-memberships.ts";

const installerUserId = "10000000-0000-4000-8000-000000002001";
const memberUserId = "10000000-0000-4000-8000-000000002002";
const foreignUserId = "10000000-0000-4000-8000-000000002003";
const slackServer = setupServer();
const originalCredentialEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY_BASE64;

interface SlackHandlerOptions {
  authTeams: Readonly<Record<string, string>>;
  userInfo(
    token: string,
    slackUserId: string,
  ):
    | { ok: false; error: string; detail?: string }
    | {
        ok: true;
        user: {
          id: string;
          team_id?: string;
          teams?: string[];
          is_stranger?: boolean;
        };
      };
}

function installSlackHandlers(options: SlackHandlerOptions): void {
  slackServer.use(
    http.post("https://slack.com/api/auth.test", ({ request }) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      const teamId = token ? options.authTeams[token] : undefined;
      if (!teamId) {
        return HttpResponse.json({ ok: false, error: "invalid_auth" });
      }
      return HttpResponse.json({ ok: true, team_id: teamId });
    }),
    http.post("https://slack.com/api/users.info", async ({ request }) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      const body = new URLSearchParams(await request.text());
      const slackUserId = body.get("user");
      if (!token || !slackUserId) {
        return HttpResponse.json({ ok: false, error: "invalid_arguments" });
      }
      return HttpResponse.json(options.userInfo(token, slackUserId));
    }),
  );
}

async function seedSlackState(
  context: TestContext,
  input: {
    accounts: Array<{ slackUserId: string; userId: string }>;
    installations: Array<{
      installerSlackUserId?: string;
      teamId: string;
      token: string;
    }>;
  },
): Promise<void> {
  for (const account of input.accounts) {
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${account.userId}::uuid, 'Legacy Slack member')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.auth_account (
            user_id, auth_provider, provider_account_id
          )
          VALUES (${account.userId}::uuid, 'slack', ${account.slackUserId})`,
    );
  }

  for (const installation of input.installations) {
    const encryptedToken = await encryptCredentialValue(
      installation.token,
      slackCredentialContext(installation.teamId, "bot_token"),
    );
    await context.db.execute(
      sql`INSERT INTO fitness.slack_installation (
            team_id,
            bot_token,
            installer_slack_user_id,
            raw_installation
          )
          VALUES (
            ${installation.teamId},
            ${encryptedToken},
            ${installation.installerSlackUserId ?? null},
            '{}'::jsonb
          )`,
    );
  }
}

describe("Slack team membership backfill (integration)", () => {
  let context: TestContext;

  beforeAll(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    slackServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  beforeEach(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterEach(async () => {
    slackServer.resetHandlers();
    await context?.cleanup();
  });

  afterAll(() => {
    slackServer.close();
    if (originalCredentialEncryptionKey === undefined) {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_BASE64;
    } else {
      process.env.CREDENTIAL_ENCRYPTION_KEY_BASE64 = originalCredentialEncryptionKey;
    }
  });

  it("dry-runs then persists installer and authoritative users.info memberships", async () => {
    await seedSlackState(context, {
      accounts: [
        { slackUserId: "U-INSTALLER-2001", userId: installerUserId },
        { slackUserId: "U-MEMBER-2001", userId: memberUserId },
        { slackUserId: "U-FOREIGN-2001", userId: foreignUserId },
      ],
      installations: [
        {
          installerSlackUserId: "U-INSTALLER-2001",
          teamId: "T-PRIMARY-2001",
          token: "xoxb-primary-2001",
        },
        { teamId: "T-SECONDARY-2001", token: "xoxb-secondary-2001" },
      ],
    });
    installSlackHandlers({
      authTeams: {
        "xoxb-primary-2001": "T-PRIMARY-2001",
        "xoxb-secondary-2001": "T-SECONDARY-2001",
      },
      userInfo: (token, slackUserId) => {
        if (token === "xoxb-primary-2001" && slackUserId === "U-MEMBER-2001") {
          return {
            ok: true,
            user: { id: slackUserId, team_id: "T-PRIMARY-2001" },
          };
        }
        if (token === "xoxb-primary-2001" && slackUserId === "U-FOREIGN-2001") {
          return {
            ok: true,
            user: {
              id: slackUserId,
              is_stranger: false,
              team_id: "T-FOREIGN-2001",
            },
          };
        }
        return { ok: false, error: "user_not_found" };
      },
    });

    await expect(
      backfillSlackTeamMemberships(context.db.$client, { execute: false }),
    ).resolves.toEqual({
      identitiesChecked: 3,
      installationsVerified: 2,
      membershipsAlreadyPresent: 0,
      membershipsDiscovered: 2,
      membershipsInserted: 0,
    });
    await expect(
      context.db.execute(sql`SELECT team_id FROM fitness.slack_team_membership`),
    ).resolves.toEqual([]);

    await expect(
      backfillSlackTeamMemberships(context.db.$client, { execute: true }),
    ).resolves.toEqual({
      identitiesChecked: 3,
      installationsVerified: 2,
      membershipsAlreadyPresent: 0,
      membershipsDiscovered: 2,
      membershipsInserted: 2,
    });

    await expect(
      context.db.execute(
        sql`SELECT team_id, user_id, slack_user_id
            FROM fitness.slack_team_membership
            ORDER BY user_id`,
      ),
    ).resolves.toEqual([
      {
        slack_user_id: "U-INSTALLER-2001",
        team_id: "T-PRIMARY-2001",
        user_id: installerUserId,
      },
      {
        slack_user_id: "U-MEMBER-2001",
        team_id: "T-PRIMARY-2001",
        user_id: memberUserId,
      },
    ]);
  });

  it("fails before installer writes when users.info lacks users:read", async () => {
    await seedSlackState(context, {
      accounts: [
        { slackUserId: "U-INSTALLER-SCOPE-2001", userId: installerUserId },
        { slackUserId: "U-MEMBER-SCOPE-2001", userId: memberUserId },
      ],
      installations: [
        {
          installerSlackUserId: "U-INSTALLER-SCOPE-2001",
          teamId: "T-SCOPE-2001",
          token: "xoxb-scope-2001",
        },
      ],
    });
    installSlackHandlers({
      authTeams: { "xoxb-scope-2001": "T-SCOPE-2001" },
      userInfo: (_token, slackUserId) =>
        slackUserId === "U-MEMBER-SCOPE-2001"
          ? {
              detail: "raw-provider-secret-2001",
              error: "missing_scope",
              ok: false,
            }
          : { error: "user_not_found", ok: false },
    });

    const failure = await backfillSlackTeamMemberships(context.db.$client, {
      execute: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("users:read");
    expect(String(failure)).not.toContain("T-SCOPE-2001");
    expect(String(failure)).not.toContain("U-MEMBER-SCOPE-2001");
    expect(String(failure)).not.toContain("raw-provider-secret-2001");
    await expect(
      context.db.execute(sql`SELECT team_id FROM fitness.slack_team_membership`),
    ).resolves.toEqual([]);
  });

  it("fails atomically when one unqualified legacy identity resolves to multiple teams", async () => {
    await seedSlackState(context, {
      accounts: [{ slackUserId: "U-AMBIGUOUS-2001", userId: installerUserId }],
      installations: [
        { teamId: "T-AMBIGUOUS-A-2001", token: "xoxb-ambiguous-a-2001" },
        { teamId: "T-AMBIGUOUS-B-2001", token: "xoxb-ambiguous-b-2001" },
      ],
    });
    installSlackHandlers({
      authTeams: {
        "xoxb-ambiguous-a-2001": "T-AMBIGUOUS-A-2001",
        "xoxb-ambiguous-b-2001": "T-AMBIGUOUS-B-2001",
      },
      userInfo: (token, slackUserId) => ({
        ok: true,
        user: {
          id: slackUserId,
          team_id: token === "xoxb-ambiguous-a-2001" ? "T-AMBIGUOUS-A-2001" : "T-AMBIGUOUS-B-2001",
        },
      }),
    });

    const failure = await backfillSlackTeamMemberships(context.db.$client, {
      execute: true,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("explicit team-qualified mapping");
    expect(String(failure)).not.toContain("U-AMBIGUOUS-2001");
    expect(String(failure)).not.toContain("T-AMBIGUOUS-A-2001");
    expect(String(failure)).not.toContain("xoxb-ambiguous-a-2001");
    await expect(
      context.db.execute(sql`SELECT team_id FROM fitness.slack_team_membership`),
    ).resolves.toEqual([]);
  });
});
