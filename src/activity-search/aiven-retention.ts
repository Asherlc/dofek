import { z } from "zod";

const backupsEndpoint = "https://api.aiven.io/v1/project/dofek/service/dofek-opensearch/backups";
const backupListSchema = z.object({
  backups: z.array(z.object({ backup_time: z.iso.datetime({ offset: true }) })),
});
const serviceLogRetentionMs = 4 * 24 * 60 * 60 * 1000;

export function createAivenSearchRetentionVerifier(environment: NodeJS.ProcessEnv = process.env) {
  const token = environment.ACTIVITY_SEARCH_RETENTION_TOKEN;
  if (!token)
    throw new Error("ACTIVITY_SEARCH_RETENTION_TOKEN is required for activity search erasure.");

  return async ({ now, piiScrubbedAt }: { now: Date; piiScrubbedAt: Date }) => {
    if (now.getTime() - piiScrubbedAt.getTime() < serviceLogRetentionMs) {
      throw new Error("Aiven service log retention has not elapsed.");
    }
    const response = await fetch(backupsEndpoint, {
      headers: { authorization: `aivenv1 ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Aiven backup listing failed with HTTP ${response.status}.`);

    const { backups } = backupListSchema.parse(await response.json());
    if (backups.some(({ backup_time }) => Date.parse(backup_time) <= piiScrubbedAt.getTime())) {
      throw new Error("Aiven retains backups from before account scrubbing.");
    }

    return { backupCount: backups.length, serviceLogsExpired: true };
  };
}
