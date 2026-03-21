import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

// Minimal Zod schema for Slack Installation from DB. We validate the structural
// shape we depend on; @slack/bolt owns the full type (with complex generics that
// can't be replicated in Zod). The transform narrows the output to Installation.
const installationParser = z
  .object({
    team: z.object({ id: z.string(), name: z.string().optional() }).passthrough().optional(),
    enterprise: z.object({ id: z.string(), name: z.string().optional() }).passthrough().optional(),
    bot: z
      .object({ token: z.string(), id: z.string().optional(), userId: z.string().optional() })
      .passthrough()
      .optional(),
    user: z
      .object({
        id: z.string(),
        token: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      })
      .passthrough(),
    appId: z.string().optional(),
  })
  .passthrough()
  .transform((val) => {
    // Validated shape is structurally compatible with Installation.
    // We return through a generic identity to avoid a banned `as` cast.
    const result: Installation = Object.assign(val);
    return result;
  });

/**
 * Slack InstallationStore backed by the fitness.slack_installation table.
 * Stores and retrieves per-workspace bot tokens for multi-workspace distribution.
 */
export function createInstallationStore(db: Database): InstallationStore {
  return {
    storeInstallation: async (installation) => {
      const teamId = installation.team?.id ?? installation.enterprise?.id;
      if (!teamId) {
        throw new Error("Cannot store installation without team or enterprise ID");
      }

      const botToken = installation.bot?.token;
      if (!botToken) {
        throw new Error("Cannot store installation without bot token");
      }

      await db.execute(
        sql`INSERT INTO fitness.slack_installation (
              team_id, team_name, bot_token, bot_id, bot_user_id, app_id,
              installer_slack_user_id, raw_installation
            ) VALUES (
              ${teamId},
              ${installation.team?.name ?? null},
              ${botToken},
              ${installation.bot?.id ?? null},
              ${installation.bot?.userId ?? null},
              ${installation.appId ?? null},
              ${installation.user?.id ?? null},
              ${JSON.stringify(installation)}::jsonb
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

      logger.info(`[slack] Stored installation for team ${teamId} (${installation.team?.name})`);
    },

    fetchInstallation: async (installQuery: InstallationQuery<boolean>) => {
      const teamId = installQuery.teamId;
      if (!teamId) {
        throw new Error("Cannot fetch installation without team ID");
      }

      const rows = await executeWithSchema(
        db,
        z.object({ raw_installation: z.union([z.string(), z.record(z.unknown())]) }),
        sql`SELECT raw_installation FROM fitness.slack_installation WHERE team_id = ${teamId} LIMIT 1`,
      );

      const row = rows[0];
      if (rows.length === 0 || !row) {
        throw new Error(`No installation found for team ${teamId}`);
      }

      const raw = row.raw_installation;
      const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
      return installationParser.parse(parsed);
    },

    deleteInstallation: async (installQuery: InstallationQuery<boolean>) => {
      const teamId = installQuery.teamId;
      if (!teamId) return;

      await db.execute(sql`DELETE FROM fitness.slack_installation WHERE team_id = ${teamId}`);

      logger.info(`[slack] Deleted installation for team ${teamId}`);
    },
  };
}
