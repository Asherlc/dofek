import { execFile } from "node:child_process";
import { waitForAuthCode } from "./auth/callback-server.ts";
import { buildAuthorizationUrl } from "./auth/index.ts";
import { computeSinceDate, parseSinceDays } from "./cli.ts";
import { createDatabaseFromEnv } from "./db/index.ts";
import { ensureProvider, saveTokens } from "./db/tokens.ts";
import { AutoSupplementsProvider } from "./providers/auto-supplements.ts";
import { Concept2Provider } from "./providers/concept2.ts";
import { CorosProvider } from "./providers/coros.ts";
import { CronometerCsvProvider } from "./providers/cronometer-csv.ts";
import { CyclingAnalyticsProvider } from "./providers/cycling-analytics.ts";
import { DecathlonProvider } from "./providers/decathlon.ts";
import { EightSleepProvider } from "./providers/eight-sleep.ts";
import { FatSecretProvider } from "./providers/fatsecret.ts";
import { FitbitProvider } from "./providers/fitbit.ts";
import { GarminProvider } from "./providers/garmin.ts";
import { getAllProviders, getEnabledProviders, registerProvider } from "./providers/index.ts";
import { KomootProvider } from "./providers/komoot.ts";
import { MapMyFitnessProvider } from "./providers/mapmyfitness.ts";
import { OuraProvider } from "./providers/oura.ts";
import { PelotonProvider } from "./providers/peloton.ts";
import { PolarProvider } from "./providers/polar.ts";
import { RideWithGpsProvider } from "./providers/ride-with-gps.ts";
import { StravaProvider } from "./providers/strava.ts";
import { StrongCsvProvider } from "./providers/strong-csv.ts";
import { SuuntoProvider } from "./providers/suunto.ts";
import { TrainerRoadProvider } from "./providers/trainerroad.ts";
import { UltrahumanProvider } from "./providers/ultrahuman.ts";
import { VeloHeroProvider } from "./providers/velohero.ts";
import { WahooProvider } from "./providers/wahoo.ts";
import { WgerProvider } from "./providers/wger.ts";
import { WhoopProvider } from "./providers/whoop.ts";
import { WithingsProvider } from "./providers/withings.ts";
import { XertProvider } from "./providers/xert.ts";
import { ZwiftProvider } from "./providers/zwift.ts";
import { runSync } from "./sync/runner.ts";

// Load supplement config from supplements.json (managed via web UI)
let supplementConfig: import("./providers/auto-supplements.ts").SupplementConfig | undefined;
try {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const jsonPath = resolve(import.meta.dirname, "../supplements.json");
  const raw = readFileSync(jsonPath, "utf-8");
  const { supplementConfigSchema } = await import("./providers/auto-supplements.ts");
  supplementConfig = supplementConfigSchema.parse(JSON.parse(raw));
} catch (err) {
  // File not found is expected — auto-supplements provider will report validation error
  // Log other errors (e.g., corrupt JSON) so they're not silently swallowed
  if (err instanceof Error && !err.message.includes("ENOENT")) {
    console.error(`[supplements] Failed to load config: ${err.message}`);
  }
}

// Register all providers
registerProvider(new WahooProvider());
registerProvider(new WithingsProvider());
registerProvider(new PelotonProvider());
registerProvider(new FatSecretProvider());
registerProvider(new FitbitProvider());
registerProvider(new GarminProvider());
registerProvider(new PolarProvider());
registerProvider(new WhoopProvider());
registerProvider(new RideWithGpsProvider());
registerProvider(new StravaProvider());
registerProvider(new OuraProvider());
registerProvider(new StrongCsvProvider());
registerProvider(new CronometerCsvProvider());
registerProvider(new EightSleepProvider());
registerProvider(new ZwiftProvider());
registerProvider(new TrainerRoadProvider());
registerProvider(new UltrahumanProvider());
registerProvider(new MapMyFitnessProvider());
registerProvider(new SuuntoProvider());
registerProvider(new CorosProvider());
registerProvider(new Concept2Provider());
registerProvider(new KomootProvider());
registerProvider(new XertProvider());
registerProvider(new CyclingAnalyticsProvider());
registerProvider(new WgerProvider());
registerProvider(new DecathlonProvider());
registerProvider(new VeloHeroProvider());
if (supplementConfig) {
  registerProvider(new AutoSupplementsProvider(supplementConfig));
}

async function main() {
  const command = process.argv[2] ?? "sync";

  // Migrations run from the web server only (packages/server/src/index.ts).
  // The sync CLI skips migrations to avoid racing the web container.

  if (command === "sync") {
    const fullSync = process.argv.includes("--full-sync");
    const days = parseSinceDays(process.argv);
    const db = createDatabaseFromEnv();
    const since = computeSinceDate(days, fullSync);

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
    if (validation) {
      console.error(`[auth] ${validation}`);
      process.exit(1);
    }

    const setup = provider.authSetup();
    if (!setup) {
      console.error(`[auth] Provider ${provider.id} does not support CLI auth — use the web UI`);
      process.exit(1);
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

    process.exit(0);
  }

  if (command === "import") {
    const subcommand = process.argv[3];

    if (subcommand === "apple-health") {
      const filePath = process.argv[4];
      if (!filePath) {
        console.error(
          "Usage: health-data import apple-health <path-to-export.zip|xml> [--full-sync] [--since-days=N]",
        );
        process.exit(1);
      }

      const fullSync = process.argv.includes("--full-sync");
      const days = parseSinceDays(process.argv);
      const since = computeSinceDate(days, fullSync);

      const { importAppleHealthFile } = await import("./providers/apple-health/index.ts");
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
