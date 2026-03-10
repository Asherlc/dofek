import { execFile } from "node:child_process";
import { createDatabaseFromEnv } from "./db/index.js";
import { runSync } from "./sync/runner.js";
import { registerProvider, getEnabledProviders, getAllProviders } from "./providers/index.js";
import { buildAuthorizationUrl } from "./auth/index.js";
import { waitForAuthCode } from "./auth/callback-server.js";
import { ensureProvider, saveTokens } from "./db/tokens.js";
import { WahooProvider } from "./providers/wahoo.js";
import { WithingsProvider } from "./providers/withings.js";
import { PelotonProvider } from "./providers/peloton.js";
import { FatSecretProvider } from "./providers/fatsecret.js";
import { AutoSupplementsProvider } from "./providers/auto-supplements.js";

// Load supplement config (optional — provider validates on sync)
let supplementConfig: import("./providers/auto-supplements.js").SupplementConfig | undefined;
try {
  const mod = await import("./supplements.config.js");
  supplementConfig = mod.default;
} catch {
  // No config file — auto-supplements provider will report validation error
}

// Register all providers
registerProvider(new WahooProvider());
registerProvider(new WithingsProvider());
registerProvider(new PelotonProvider());
registerProvider(new FatSecretProvider());
if (supplementConfig) {
  registerProvider(new AutoSupplementsProvider(supplementConfig));
}

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

    const setup = provider.authSetup();
    const { oauthConfig, exchangeCode, apiBaseUrl } = setup;

    let tokens;

    // OAuth 1.0 3-legged flow (FatSecret)
    if ("oauth1Flow" in setup && setup.oauth1Flow) {
      const oauth1 = setup.oauth1Flow as {
        getRequestToken: (callbackUrl: string) => Promise<{ oauthToken: string; oauthTokenSecret: string; authorizeUrl: string }>;
        exchangeForAccessToken: (requestToken: string, requestTokenSecret: string, oauthVerifier: string) => Promise<{ token: string; tokenSecret: string }>;
      };

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
        console.error(`[auth] ${provider.id.toUpperCase()}_USERNAME and ${provider.id.toUpperCase()}_PASSWORD required`);
        process.exit(1);
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
      const { code, cleanup: cleanupServer } = await waitForAuthCode(callbackPort, { https: useHttps });
      console.log("[auth] Received authorization code. Exchanging for tokens...");
      tokens = await exchangeCode(code);
      cleanupServer();
    }

    console.log(`[auth] Authorized! Token expires at ${tokens.expiresAt.toISOString()}`);

    const db = createDatabaseFromEnv();
    await ensureProvider(db, provider.id, provider.name, apiBaseUrl);
    await saveTokens(db, provider.id, tokens);
    console.log("[auth] Tokens saved to database.");

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
