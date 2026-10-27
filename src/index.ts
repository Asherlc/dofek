import { execFile } from "node:child_process";
import { waitForAuthCode } from "./auth/callback-server.ts";
import { buildAuthorizationUrl } from "./auth/oauth.ts";
import { parseSinceDays, resolveCliUserId } from "./cli.ts";
import { handleSyncCommand } from "./cli-sync.ts";

export { handleSyncCommand };

import { createDatabaseFromEnv } from "./db/index.ts";
import { runWithTokenUser } from "./db/token-user-context.ts";
import { ensureProvider, saveTokens } from "./db/tokens.ts";
import { ensureProvidersRegistered } from "./jobs/provider-registration.ts";
import { logger } from "./logger.ts";
import { startMetricStreamClickHouseSinkFromEnv } from "./metric-stream/clickhouse-sink.ts";
import { getAllProviders } from "./providers/index.ts";

export async function handleAuthCommand(args: string[]): Promise<number> {
  await ensureProvidersRegistered();

  const providerArg = args[3];

  // Find providers that support OAuth auth
  const allProviders = getAllProviders();
  const oauthProviders = allProviders.filter((p) => p.authSetup);
  const provider = oauthProviders.find((p) => p.id === providerArg);

  if (!providerArg || !provider?.authSetup) {
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

  let tokens: import("./auth/oauth.ts").TokenSet;
  const { apiBaseUrl } = setup;

  // OAuth 1.0 3-legged flow (FatSecret)
  if (setup.oauth1Flow) {
    if (!setup.oauthConfig) {
      logger.error(`[auth] Provider ${providerArg} requires oauthConfig for OAuth 1.0`);
      return 1;
    }
    const oauth1 = setup.oauth1Flow;
    const { oauthConfig } = setup;

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
    if (!setup.oauthConfig || !setup.exchangeCode) {
      logger.error(
        `[auth] Provider ${providerArg} requires oauthConfig and exchangeCode for OAuth 2.0`,
      );
      return 1;
    }
    const { oauthConfig, exchangeCode } = setup;
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
    try {
      logger.info("[auth] Received authorization code. Exchanging for tokens...");
      tokens = await exchangeCode(code);
    } finally {
      cleanupServer();
    }
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

    const { importAppleHealthFile } = await import("./providers/apple-health/import.ts");
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

export async function main() {
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

  if (command === "metric-stream-clickhouse-sink") {
    await startMetricStreamClickHouseSinkFromEnv();
    return;
  }

  logger.error(
    `Unknown command: ${command}\nUsage: health-data <sync|auth|import|metric-stream-clickhouse-sink>`,
  );
  process.exit(1);
}

main();
