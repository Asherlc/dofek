import type { Database } from "dofek/db";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "dofek/security/credential-encryption";
import { slackCredentialContext } from "dofek/security/slack-credential-context";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const botCredentialsRowSchema = z.object({
  bot_token: z.string(),
  bot_id: z.string().nullable(),
  bot_user_id: z.string().nullable(),
});

const rawInstallationRowSchema = z.object({
  raw_installation: z.union([z.string(), z.record(z.string(), z.unknown())]),
});

export interface SlackInstallationUpsertInput {
  teamId: string;
  teamName: string | null;
  botToken: string;
  botId: string | null;
  botUserId: string | null;
  appId: string | null;
  installerSlackUserId: string | null;
  rawInstallation: unknown;
}

export interface SlackMemberInstallationUpsertInput extends SlackInstallationUpsertInput {
  slackUserId: string;
  userId: string;
}

export interface SlackTeamMembershipUpsertInput {
  slackUserId: string;
  teamId: string;
  userId: string;
}

export interface SlackBotCredentials {
  botToken: string;
  botId: string | null;
  botUserId: string | null;
}

export class SlackInstallationRepository {
  readonly #db: Pick<Database, "execute">;

  constructor(db: Pick<Database, "execute">) {
    this.#db = db;
  }

  async upsertInstallation(input: SlackInstallationUpsertInput): Promise<void> {
    const encryptedBotToken = await encryptCredentialValue(
      input.botToken,
      slackCredentialContext(input.teamId, "bot_token"),
    );
    const encryptedRawInstallation = await encryptCredentialValue(
      JSON.stringify(input.rawInstallation),
      slackCredentialContext(input.teamId, "raw_installation"),
    );

    await this.#db.execute(
      sql`INSERT INTO fitness.slack_installation (
            team_id, team_name, bot_token, bot_id, bot_user_id, app_id,
            installer_slack_user_id, raw_installation
          ) VALUES (
            ${input.teamId},
            ${input.teamName},
            ${encryptedBotToken},
            ${input.botId},
            ${input.botUserId},
            ${input.appId},
            ${input.installerSlackUserId},
            to_jsonb(${encryptedRawInstallation}::text)
          )
          ON CONFLICT (team_id) DO UPDATE SET
            team_name = EXCLUDED.team_name,
            bot_token = EXCLUDED.bot_token,
            bot_id = EXCLUDED.bot_id,
            bot_user_id = EXCLUDED.bot_user_id,
            app_id = EXCLUDED.app_id,
            installer_slack_user_id = EXCLUDED.installer_slack_user_id,
            raw_installation = EXCLUDED.raw_installation,
            updated_at = NOW()`,
    );
  }

  async upsertMemberInstallation(input: SlackMemberInstallationUpsertInput): Promise<void> {
    const encryptedBotToken = await encryptCredentialValue(
      input.botToken,
      slackCredentialContext(input.teamId, "bot_token"),
    );
    const encryptedRawInstallation = await encryptCredentialValue(
      JSON.stringify(input.rawInstallation),
      slackCredentialContext(input.teamId, "raw_installation"),
    );

    await this.#db.execute(
      sql`WITH installed AS (
            INSERT INTO fitness.slack_installation (
              team_id, team_name, bot_token, bot_id, bot_user_id, app_id,
              installer_slack_user_id, raw_installation
            ) VALUES (
              ${input.teamId},
              ${input.teamName},
              ${encryptedBotToken},
              ${input.botId},
              ${input.botUserId},
              ${input.appId},
              ${input.installerSlackUserId},
              to_jsonb(${encryptedRawInstallation}::text)
            )
            ON CONFLICT (team_id) DO UPDATE SET
              team_name = EXCLUDED.team_name,
              bot_token = EXCLUDED.bot_token,
              bot_id = EXCLUDED.bot_id,
              bot_user_id = EXCLUDED.bot_user_id,
              app_id = EXCLUDED.app_id,
              installer_slack_user_id = EXCLUDED.installer_slack_user_id,
              raw_installation = EXCLUDED.raw_installation,
              updated_at = NOW()
            RETURNING team_id
          ),
          reassigned_identity AS (
            DELETE FROM fitness.slack_team_membership
            WHERE team_id = ${input.teamId}
              AND slack_user_id = ${input.slackUserId}
              AND user_id <> ${input.userId}::uuid
            RETURNING user_id
          )
          INSERT INTO fitness.slack_team_membership (
            team_id, user_id, slack_user_id
          )
          SELECT
            installed.team_id,
            ${input.userId}::uuid,
            ${input.slackUserId}
          FROM installed
          LEFT JOIN reassigned_identity ON true
          ON CONFLICT (team_id, user_id) DO UPDATE SET
            slack_user_id = EXCLUDED.slack_user_id,
            updated_at = NOW()`,
    );
  }

  async upsertTeamMembership(input: SlackTeamMembershipUpsertInput): Promise<void> {
    await this.#db.execute(
      sql`WITH reassigned_identity AS (
            DELETE FROM fitness.slack_team_membership
            WHERE team_id = ${input.teamId}
              AND slack_user_id = ${input.slackUserId}
              AND user_id <> ${input.userId}::uuid
            RETURNING user_id
          )
          INSERT INTO fitness.slack_team_membership (
            team_id, user_id, slack_user_id
          )
          SELECT
            ${input.teamId},
            ${input.userId}::uuid,
            ${input.slackUserId}
          FROM (VALUES (true)) AS membership_candidate(required)
          LEFT JOIN reassigned_identity
            ON membership_candidate.required
          WHERE NOT EXISTS (
            SELECT 1
            FROM fitness.slack_team_membership
            WHERE team_id = ${input.teamId}
              AND user_id = ${input.userId}::uuid
              AND slack_user_id = ${input.slackUserId}
          )
          ON CONFLICT (team_id, user_id) DO UPDATE SET
            slack_user_id = EXCLUDED.slack_user_id,
            updated_at = NOW()`,
    );
  }

  async getBotCredentialsByTeamId(teamId: string): Promise<SlackBotCredentials | null> {
    const rows = await executeWithSchema(
      this.#db,
      botCredentialsRowSchema,
      sql`SELECT bot_token, bot_id, bot_user_id
          FROM fitness.slack_installation
          WHERE team_id = ${teamId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      return null;
    }

    const botToken = await decryptCredentialValue(
      row.bot_token,
      slackCredentialContext(teamId, "bot_token"),
    );
    return {
      botToken,
      botId: row.bot_id,
      botUserId: row.bot_user_id,
    };
  }

  async getRawInstallationByTeamId(teamId: string): Promise<unknown | null> {
    const rows = await executeWithSchema(
      this.#db,
      rawInstallationRowSchema,
      sql`SELECT raw_installation FROM fitness.slack_installation
          WHERE team_id = ${teamId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      return null;
    }

    const raw = row.raw_installation;
    if (typeof raw !== "string") {
      return raw;
    }

    const decryptedRawInstallation = await decryptCredentialValue(
      raw,
      slackCredentialContext(teamId, "raw_installation"),
    );
    return JSON.parse(decryptedRawInstallation);
  }

  async deleteByTeamId(teamId: string): Promise<void> {
    await this.#db.execute(sql`DELETE FROM fitness.slack_installation WHERE team_id = ${teamId}`);
  }
}
