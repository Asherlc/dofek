import { createDatabaseFromEnv } from "./db/index.js";
import { runSync } from "./sync/runner.js";
import { getEnabledProviders } from "./providers/index.js";
import { buildAuthorizationUrl, exchangeCodeForTokens } from "./auth/index.js";
import { waitForAuthCode } from "./auth/callback-server.js";
import { wahooOAuthConfig } from "./providers/wahoo.js";

function parseSinceDays(): number {
  const arg = process.argv.find((a) => a.startsWith("--since-days="));
  if (arg) return parseInt(arg.split("=")[1], 10);
  return 7;
}

async function main() {
  const command = process.argv[2] ?? "sync";

  if (command === "sync") {
    const days = parseSinceDays();
    const db = createDatabaseFromEnv();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const enabled = getEnabledProviders();
    if (enabled.length === 0) {
      console.log("[sync] No providers enabled. Set API keys in .env to enable providers.");
      process.exit(0);
    }

    console.log(`[sync] Running sync for ${enabled.length} provider(s) since ${since.toISOString()}`);
    const result = await runSync(db, since);
    console.log(
      `[sync] Done: ${result.totalRecords} records, ${result.totalErrors} errors in ${result.duration}ms`,
    );

    process.exit(result.totalErrors > 0 ? 1 : 0);
  }

  if (command === "auth") {
    const providerArg = process.argv[3];
    if (providerArg !== "wahoo") {
      console.error("Usage: health-data auth wahoo");
      process.exit(1);
    }

    const config = wahooOAuthConfig();
    const validation = new (await import("./providers/wahoo.js")).WahooProvider().validate();
    if (validation) {
      console.error(`[auth] ${validation}`);
      process.exit(1);
    }

    const authUrl = buildAuthorizationUrl(config);
    console.log(`[auth] Open this URL in your browser:\n\n  ${authUrl}\n`);
    console.log("[auth] Waiting for callback...");

    const { code, cleanup } = await waitForAuthCode(9876);
    console.log("[auth] Received authorization code. Exchanging for tokens...");

    const tokens = await exchangeCodeForTokens(config, code);
    console.log(`[auth] Authorized! Token expires at ${tokens.expiresAt.toISOString()}`);

    // TODO: Store tokens in DB
    console.log("[auth] Access token:", tokens.accessToken.slice(0, 10) + "...");
    console.log("[auth] Refresh token:", tokens.refreshToken.slice(0, 10) + "...");

    cleanup();
    process.exit(0);
  }

  console.error(`Unknown command: ${command}\nUsage: health-data <sync|auth>`);
  process.exit(1);
}

main();
