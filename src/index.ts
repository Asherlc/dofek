import { execFile } from "node:child_process";
import { QueueEvents, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { waitForAuthCode } from "./auth/callback-server.ts";
import { buildAuthorizationUrl } from "./auth/index.ts";
import { parseSinceDays } from "./cli.ts";
import { createDatabaseFromEnv } from "./db/index.ts";
import { runWithTokenUser } from "./db/token-user-context.ts";
import { ensureProvider, saveTokens } from "./db/tokens.ts";
import { processSyncJob } from "./jobs/process-sync-job.ts";
import { ensureProvidersRegistered } from "./jobs/provider-registration.ts";
import {
  createSyncQueue,
  getRedisConnection,
  SYNC_QUEUE,
  type SyncJobData,
} from "./jobs/queues.ts";
import { logger } from "./logger.ts";
import { getAllProviders, getEnabledSyncProviders } from "./providers/index.ts";

async function resolveCliUserId(db: ReturnType<typeof createDatabaseFromEnv>): Promise<string> {
  const envUserId = process.env.DOFEK_USER_ID;
  if (envUserId) return envUserId;

  const rows = await db.execute(
    sql`SELECT id::text AS id FROM fitness.user_profile ORDER BY created_at ASC LIMIT 1`,
  );
  const parsed = z.object({ id: z.string() }).safeParse(rows[0]);
  if (parsed.success) return parsed.data.id;

  throw new Error("No user found. Set DOFEK_USER_ID or create a user first.");
}

export async function handleSyncCommand(args: string[]): Promise<number> {
  const fullSync = args.includes("--full-sync");
  const days = parseSinceDays(args);

  // Register all providers so processSyncJob can use them
  await ensureProvidersRegistered();

  const enabled = getEnabledSyncProviders();
  if (enabled.length === 0) {
    logger.info("[sync] No syncable providers enabled. Set API keys in .env to enable providers.");
    return 0;
  }

  const db = createDatabaseFromEnv();
  const connection = getRedisConnection();
  const queue = createSyncQueue(connection);
  const userId = await resolveCliUserId(db);

  const jobs = await Promise.all(
    enabled.map((provider) =>
      queue.add("sync", {
        providerId: provider.id,
        sinceDays: fullSync ? undefined : days,
        userId,
      } satisfies SyncJobData),
    ),
  );
  const label = fullSync ? "all time" : `last ${days} days`;
  logger.info(`[sync] Enqueued ${jobs.length} sync job(s), one per provider — ${label}`);

  // Process the job inline with a temporary worker
  const worker = new Worker<SyncJobData>(SYNC_QUEUE, (j) => processSyncJob(j, db), {
    connection,
  });
  const queueEvents = new QueueEvents(SYNC_QUEUE, { connection });

  try {
    const results = await Promise.allSettled(jobs.map((job) => job.waitUntilFinished(queueEvents)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
    logger.info("[sync] Done.");
    return 0;
  } catch (err) {
    logger.error(`[sync] Failed: ${err}`);
    return 1;
  } finally {
    await worker.close();
    await queueEvents.close();
    await queue.close();
  }
}

export async function handleAuthCommand(args: string[]): Promise<number> {
  await ensureProvidersRegistered();

  const providerArg = args[3];

  // Find providers that support OAuth auth
  const allProviders = getAllProviders();
  const oauthProviders = allProviders.filter((p) => p.authSetup);
  const provider = oauthProviders.find((p) => p.id === providerArg);

  if (!providerArg || !provider || !provider.authSetup) {
    const supported = oauthProviders.map((p) => p.id).join("|");
    logger.error(`Usage: health-data auth <${supported}>`);
    return 1;
  }

  const validation = provider.validate();
  if (validation) {
    logger.error(`[auth] ${validation}`);
    return 1;
  }

  const setup = provider.authSetup?.();
  if (!setup) {
    logger.error(
      `[auth] Provider ${providerArg} is not configured for OAuth. ` +
        `Check environment variables for credentials (e.g., ${providerArg.toUpperCase()}_CLIENT_ID).`,
    );
    return 1;
  }
  const { oauthConfig, exchangeCode, apiBaseUrl } = setup;

  let tokens: import("./auth/oauth.ts").TokenSet;

  // OAuth 1.0 3-legged flow (FatSecret)
  if (setup.oauth1Flow) {
    const oauth1 = setup.oauth1Flow;

    const callbackUrl = oauthConfig.redirectUri;
    const callbackParsed = new URL(callbackUrl);
    const callbackPort = parseInt(callbackParsed.port || "9876", 10);

    logger.info("[auth] Requesting OAuth 1.0 request token...");
    const requestToken = await oauth1.getRequestToken(callbackUrl);

    logger.info(`[auth] Opening browser...\n\n  ${requestToken.authorizeUrl}\n`);
    execFile("open", [requestToken.authorizeUrl]);
    logger.info("[auth] Waiting for callback...");

    const { code: verifier, cleanup: cleanupServer } = await waitForAuthCode(callbackPort, {
      https: false,
      paramName: "oauth_verifier",
    });
    cleanupServer();

    logger.info("[auth] Exchanging for access token...");
    const accessToken = await oauth1.exchangeForAccessToken(
      requestToken.oauthToken,
      requestToken.oauthTokenSecret,
      verifier,
    );

    // Store OAuth 1.0 tokens in the existing oauthToken table
    // token → accessToken, tokenSecret → refreshToken, far-future expiry
    tokens = {
      accessToken: accessToken.token,
      refreshToken: accessToken.tokenSecret,
      expiresAt: new Date("2099-12-31T23:59:59Z"),
      scopes: "",
    };
  } else if (setup.automatedLogin) {
    // Automated login flow (no browser needed)
    const email = process.env[`${provider.id.toUpperCase()}_USERNAME`];
    const password = process.env[`${provider.id.toUpperCase()}_PASSWORD`];
    if (!email || !password) {
      logger.error(
        `[auth] ${provider.id.toUpperCase()}_USERNAME and ${provider.id.toUpperCase()}_PASSWORD required`,
      );
      return 1;
    }
    logger.info(`[auth] Logging in as ${email}...`);
    tokens = await setup.automatedLogin(email, password);
  } else {
    // Browser-based OAuth 2.0 flow
    const authUrl = setup.authUrl ?? buildAuthorizationUrl(oauthConfig);
    logger.info(`[auth] Opening browser...\n\n  ${authUrl}\n`);
    execFile("open", [authUrl]);
    logger.info("[auth] Waiting for callback...");

    const callbackUrl = new URL(oauthConfig.redirectUri);
    const callbackPort = parseInt(callbackUrl.port || "9876", 10);
    const useHttps = callbackUrl.protocol === "https:";
    const { code, cleanup: cleanupServer } = await waitForAuthCode(callbackPort, {
      https: useHttps,
    });
    logger.info("[auth] Received authorization code. Exchanging for tokens...");
    tokens = await exchangeCode(code);
    cleanupServer();
  }

  logger.info(`[auth] Authorized! Token expires at ${tokens.expiresAt.toISOString()}`);

  const db = createDatabaseFromEnv();
  const userId = await resolveCliUserId(db);
  await ensureProvider(db, provider.id, provider.name, apiBaseUrl, userId);
  await saveTokens(db, provider.id, tokens, userId);
  logger.info("[auth] Tokens saved to database.");

  return 0;
}

export async function handleImportCommand(args: string[]): Promise<number> {
  const subcommand = args[3];

  if (subcommand === "apple-health") {
    const filePath = args[4];
    if (!filePath) {
      logger.error(
        "Usage: health-data import apple-health <path-to-export.zip|xml> [--full-sync] [--since-days=N]",
      );
      return 1;
    }

    const fullSync = args.includes("--full-sync");
    const days = parseSinceDays(args);
    const since = fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { importAppleHealthFile } = await import("./providers/apple-health/index.ts");
    const db = createDatabaseFromEnv();
    const userId = await resolveCliUserId(db);
    const result = await runWithTokenUser(userId, () => importAppleHealthFile(db, filePath, since));
    logger.info(
      `[import] Done: ${result.recordsSynced} records, ${result.errors.length} errors in ${result.duration}ms`,
    );
    if (result.errors.length > 0) {
      for (const err of result.errors) logger.error(`  - ${err.message}`);
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  logger.error("Usage: health-data import <apple-health> <file>");
  return 1;
}

async function main() {
  const command = process.argv[2] ?? "sync";

  if (command === "sync") {
    process.exit(await handleSyncCommand(process.argv));
  }

  if (command === "auth") {
    process.exit(await handleAuthCommand(process.argv));
  }

  if (command === "import") {
    process.exit(await handleImportCommand(process.argv));
  }

  logger.error(`Unknown command: ${command}\nUsage: health-data <sync|auth|import>`);
  process.exit(1);
}

main();
