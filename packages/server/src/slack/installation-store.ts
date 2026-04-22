import type { Installation, InstallationQuery, InstallationStore } from "@slack/bolt";
import type { Database } from "dofek/db";
import { z } from "zod";
import { logger } from "../logger.ts";
import { SlackInstallationRepository } from "../repositories/slack-installation-repository.ts";

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
  const slackInstallationRepository = new SlackInstallationRepository(db);

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
      await slackInstallationRepository.upsertInstallation({
        teamId,
        teamName: installation.team?.name ?? null,
        botToken,
        botId: installation.bot?.id ?? null,
        botUserId: installation.bot?.userId ?? null,
        appId: installation.appId ?? null,
        installerSlackUserId: installation.user?.id ?? null,
        rawInstallation: installation,
      });

      logger.info(`[slack] Stored installation for team ${teamId} (${installation.team?.name})`);
    },

    fetchInstallation: async (installQuery: InstallationQuery<boolean>) => {
      const teamId = installQuery.teamId;
      if (!teamId) {
        throw new Error("Cannot fetch installation without team ID");
      }

      const rawInstallation = await slackInstallationRepository.getRawInstallationByTeamId(teamId);
      if (!rawInstallation) {
        throw new Error(`No installation found for team ${teamId}`);
      }

      return installationParser.parse(rawInstallation);
    },

    deleteInstallation: async (installQuery: InstallationQuery<boolean>) => {
      const teamId = installQuery.teamId;
      if (!teamId) return;

      await slackInstallationRepository.deleteByTeamId(teamId);

      logger.info(`[slack] Deleted installation for team ${teamId}`);
    },
  };
}
