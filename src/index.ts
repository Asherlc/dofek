import { createDatabaseFromEnv } from "./db/index.js";
import { runSync } from "./sync/runner.js";
import { registerProvider, getEnabledProviders, getAllProviders } from "./providers/index.js";
import { buildAuthorizationUrl } from "./auth/index.js";
import { waitForAuthCode } from "./auth/callback-server.js";
import { ensureProvider, saveTokens } from "./db/tokens.js";
import { WahooProvider } from "./providers/wahoo.js";
import { WithingsProvider } from "./providers/withings.js";

// Register all providers
registerProvider(new WahooProvider());
registerProvider(new WithingsProvider());

function parseSinceDays(): number {
  const arg = process.argv.find((a) => a.startsWith("--since-days="));
  if (arg) return parseInt(arg.split("=")[1], 10);
  return 7;
}

async function main() {
  const command = process.argv[2] ?? "sync";

  if (command === "sync") {
    const fullSync = process.argv.includes("--full-sync");
    const days = parseSinceDays();
    const db = createDatabaseFromEnv();
    const since = fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const enabled = getEnabledProviders();
    if (enabled.length === 0) {
      console.log("[sync] No providers enabled. Set API keys in .env to enable providers.");
      process.exit(0);
    }

    const label = fullSync ? "all time" : `since ${since.toISOString()}`;
    console.log(`[sync] Running sync for ${enabled.length} provider(s) — ${label}`);
    const result = await runSync(db, since);
    console.log(
      `[sync] Done: ${result.totalRecords} records, ${result.totalErrors} errors in ${result.duration}ms`,
    );

    process.exit(result.totalErrors > 0 ? 1 : 0);
  }

  if (command === "auth") {
    const providerArg = process.argv[3];

    // Find providers that support OAuth auth
    const allProviders = getAllProviders();
    const oauthProviders = allProviders.filter((p) => p.authSetup);
    const provider = oauthProviders.find((p) => p.id === providerArg);

    if (!provider || !provider.authSetup) {
      const supported = oauthProviders.map((p) => p.id).join("|");
      console.error(`Usage: health-data auth <${supported}>`);
      process.exit(1);
    }

    const validation = provider.validate();
    if (validation) { console.error(`[auth] ${validation}`); process.exit(1); }

    const { oauthConfig, exchangeCode, apiBaseUrl } = provider.authSetup();

    const authUrl = buildAuthorizationUrl(oauthConfig);
    console.log(`[auth] Open this URL in your browser:\n\n  ${authUrl}\n`);
    console.log("[auth] Waiting for callback...");

    const callbackUrl = new URL(oauthConfig.redirectUri);
    const callbackPort = parseInt(callbackUrl.port || "9876", 10);
    const useHttps = callbackUrl.protocol === "https:";
    const { code, cleanup } = await waitForAuthCode(callbackPort, { https: useHttps });
    console.log("[auth] Received authorization code. Exchanging for tokens...");

    const tokens = await exchangeCode(code);
    console.log(`[auth] Authorized! Token expires at ${tokens.expiresAt.toISOString()}`);

    const db = createDatabaseFromEnv();
    await ensureProvider(db, provider.id, provider.name, apiBaseUrl);
    await saveTokens(db, provider.id, tokens);
    console.log("[auth] Tokens saved to database.");

    cleanup();
    process.exit(0);
  }

  if (command === "import") {
    const subcommand = process.argv[3];

    if (subcommand === "apple-health") {
      const filePath = process.argv[4];
      if (!filePath) {
        console.error("Usage: health-data import apple-health <path-to-export.zip|xml> [--full-sync] [--since-days=N]");
        process.exit(1);
      }

      const fullSync = process.argv.includes("--full-sync");
      const days = parseSinceDays();
      const since = fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const { importAppleHealthFile } = await import("./providers/apple-health.js");
      const db = createDatabaseFromEnv();
      const result = await importAppleHealthFile(db, filePath, since);
      console.log(
        `[import] Done: ${result.recordsSynced} records, ${result.errors.length} errors in ${result.duration}ms`,
      );
      if (result.errors.length > 0) {
        for (const err of result.errors) console.error(`  - ${err.message}`);
      }
      process.exit(result.errors.length > 0 ? 1 : 0);
    }

    console.error("Usage: health-data import <apple-health> <file>");
    process.exit(1);
  }

  console.error(`Unknown command: ${command}\nUsage: health-data <sync|auth|import>`);
  process.exit(1);
}

main();
