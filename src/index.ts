import { execFile } from "node:child_process";
import { QueueEvents, Worker } from "bullmq";
import { waitForAuthCode } from "./auth/callback-server.ts";
import { buildAuthorizationUrl } from "./auth/index.ts";
import { parseSinceDays } from "./cli.ts";
import { createDatabaseFromEnv } from "./db/index.ts";
import { ensureProvider, saveTokens } from "./db/tokens.ts";
import { processSyncJob } from "./jobs/process-sync-job.ts";
import { ensureProvidersRegistered } from "./jobs/provider-registration.ts";
import {
  createSyncQueue,
  getRedisConnection,
  SYNC_QUEUE,
  type SyncJobData,
} from "./jobs/queues.ts";
import { getAllProviders, getEnabledProviders } from "./providers/index.ts";

export async function handleSyncCommand(args: string[]): Promise<number> {
  const fullSync = args.includes("--full-sync");
  const days = parseSinceDays(args);

  // Register all providers so processSyncJob can use them
  await ensureProvidersRegistered();

  const enabled = getEnabledProviders();
  if (enabled.length === 0) {
    console.log("[sync] No providers enabled. Set API keys in .env to enable providers.");
    return 0;
  }

  const db = createDatabaseFromEnv();
  const connection = getRedisConnection();
  const queue = createSyncQueue(connection);
  const { DEFAULT_USER_ID } = await import("./db/schema.ts");

  const jobData: SyncJobData = {
    sinceDays: fullSync ? undefined : days,
    userId: DEFAULT_USER_ID,
  };

  const job = await queue.add("sync", jobData);
  const label = fullSync ? "all time" : `last ${days} days`;
  console.log(`[sync] Enqueued sync job for ${enabled.length} provider(s) — ${label}`);

  // Process the job inline with a temporary worker
  const worker = new Worker<SyncJobData>(SYNC_QUEUE, (j) => processSyncJob(j, db), {
    connection,
  });
  const queueEvents = new QueueEvents(SYNC_QUEUE, { connection });

  try {
    await job.waitUntilFinished(queueEvents);
    console.log("[sync] Done.");
    return 0;
  } catch (err) {
    console.error(`[sync] Failed: ${err}`);
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
    console.error(`Usage: health-data auth <${supported}>`);
    return 1;
  }

  const validation = provider.validate();
  if (validation) {
    console.error(`[auth] ${validation}`);
    return 1;
  }

  const setup = provider.authSetup?.();
  if (!setup) {
    console.error(
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

    console.log("[auth] Requesting OAuth 1.0 request token...");
    const requestToken = await oauth1.getRequestToken(callbackUrl);

    console.log(`[auth] Opening browser...\n\n  ${requestToken.authorizeUrl}\n`);
    execFile("open", [requestToken.authorizeUrl]);
    console.log("[auth] Waiting for callback...");

    const { code: verifier, cleanup: cleanupServer } = await waitForAuthCode(callbackPort, {
      https: false,
      paramName: "oauth_verifier",
    });
    cleanupServer();

    console.log("[auth] Exchanging for access token...");
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
      console.error(
        `[auth] ${provider.id.toUpperCase()}_USERNAME and ${provider.id.toUpperCase()}_PASSWORD required`,
      );
      return 1;
    }
    console.log(`[auth] Logging in as ${email}...`);
    tokens = await setup.automatedLogin(email, password);
  } else {
    // Browser-based OAuth 2.0 flow
    const authUrl = setup.authUrl ?? buildAuthorizationUrl(oauthConfig);
    console.log(`[auth] Opening browser...\n\n  ${authUrl}\n`);
    execFile("open", [authUrl]);
    console.log("[auth] Waiting for callback...");

    const callbackUrl = new URL(oauthConfig.redirectUri);
    const callbackPort = parseInt(callbackUrl.port || "9876", 10);
    const useHttps = callbackUrl.protocol === "https:";
    const { code, cleanup: cleanupServer } = await waitForAuthCode(callbackPort, {
      https: useHttps,
    });
    console.log("[auth] Received authorization code. Exchanging for tokens...");
    tokens = await exchangeCode(code);
    cleanupServer();
  }

  console.log(`[auth] Authorized! Token expires at ${tokens.expiresAt.toISOString()}`);

  const db = createDatabaseFromEnv();
  await ensureProvider(db, provider.id, provider.name, apiBaseUrl);
  await saveTokens(db, provider.id, tokens);
  console.log("[auth] Tokens saved to database.");

  return 0;
}

export async function handleImportCommand(args: string[]): Promise<number> {
  const subcommand = args[3];

  if (subcommand === "apple-health") {
    const filePath = args[4];
    if (!filePath) {
      console.error(
        "Usage: health-data import apple-health <path-to-export.zip|xml> [--full-sync] [--since-days=N]",
      );
      return 1;
    }

    const fullSync = args.includes("--full-sync");
    const days = parseSinceDays(args);
    const since = fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { importAppleHealthFile } = await import("./providers/apple-health/index.ts");
    const db = createDatabaseFromEnv();
    const result = await importAppleHealthFile(db, filePath, since);
    console.log(
      `[import] Done: ${result.recordsSynced} records, ${result.errors.length} errors in ${result.duration}ms`,
    );
    if (result.errors.length > 0) {
      for (const err of result.errors) console.error(`  - ${err.message}`);
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  console.error("Usage: health-data import <apple-health> <file>");
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

  console.error(`Unknown command: ${command}\nUsage: health-data <sync|auth|import>`);
  process.exit(1);
}

main();
