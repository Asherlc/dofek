import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import compression from "compression";
import cookieParser from "cookie-parser";
import { createDatabaseFromEnv } from "dofek/db";
import { runMigrations } from "dofek/db/migrate";
import { DEFAULT_USER_ID } from "dofek/db/schema";
import { sql } from "drizzle-orm";
import express from "express";
import {
  clearOAuthFlowCookies,
  clearSessionCookie,
  getOAuthFlowCookies,
  getSessionCookie,
  setOAuthFlowCookies,
  setSessionCookie,
} from "./auth/cookies.ts";
import {
  generateCodeVerifier,
  generateState,
  getConfiguredProviders,
  getIdentityProvider,
  type IdentityProviderName,
  isProviderConfigured,
} from "./auth/providers.ts";
import { createSession, deleteSession, validateSession } from "./auth/session.ts";
import { httpRequestDuration, registry } from "./lib/metrics.ts";
import { logger } from "./logger.ts";
import { appRouter } from "./router.ts";
import { startSlackBot } from "./slack/bot.ts";
import type { Context } from "./trpc.ts";

/** Fire common queries sequentially to populate cache without overwhelming the DB.
 *  Uses DEFAULT_USER_ID for backwards compatibility — only warms for the primary user. */
async function warmCache(db: import("dofek/db").Database) {
  const caller = appRouter.createCaller({ db, userId: DEFAULT_USER_ID });
  const queries: Array<[string, () => Promise<unknown>]> = [
    // Dashboard
    ["dailyMetrics.list(30)", () => caller.dailyMetrics.list({ days: 30 })],
    ["dailyMetrics.list(90)", () => caller.dailyMetrics.list({ days: 90 })],
    ["dailyMetrics.trends(30)", () => caller.dailyMetrics.trends({ days: 30 })],
    ["dailyMetrics.latest", () => caller.dailyMetrics.latest()],
    ["sleep.list(30)", () => caller.sleep.list({ days: 30 })],
    ["sync.providers", () => caller.sync.providers()],
    ["sync.providerStats", () => caller.sync.providerStats()],
    ["insights.compute(90)", () => caller.insights.compute({ days: 90 })],
    // Training page
    ["training.weeklyVolume(90)", () => caller.training.weeklyVolume({ days: 90 })],
    ["training.hrZones(90)", () => caller.training.hrZones({ days: 90 })],
    ["pmc.chart(90)", () => caller.pmc.chart({ days: 90 })],
    ["power.powerCurve(90)", () => caller.power.powerCurve({ days: 90 })],
    ["power.eftpTrend(90)", () => caller.power.eftpTrend({ days: 90 })],
  ];
  let ok = 0;
  for (const [name, fn] of queries) {
    try {
      await fn();
      ok++;
    } catch (err) {
      logger.error(`[cache] Failed to warm ${name}: ${err}`);
    }
  }
  logger.info(`[cache] Warmed ${ok}/${queries.length} queries`);
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);

/** Stream a request body to a file on disk. */
function streamToFile(req: import("express").Request, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    req.pipe(ws);
    ws.on("finish", resolve);
    ws.on("error", reject);
    req.on("error", reject);
  });
}

/** Concatenate chunk files in order into a single output file. */
async function assembleChunks(chunkDir: string, outputPath: string): Promise<void> {
  const { createReadStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const files = (await readdir(chunkDir)).filter((f) => f.startsWith("chunk-")).sort();
  const ws = createWriteStream(outputPath);
  for (const file of files) {
    await pipeline(createReadStream(join(chunkDir, file)), ws, { end: false });
  }
  ws.end();
  await new Promise<void>((resolve, reject) => {
    ws.on("finish", resolve);
    ws.on("error", reject);
  });
}

/** Create the Express app with all routes. Exported for testing. */
export function createApp(db: import("dofek/db").Database): express.Express {
  const app = express();
  setupRoutes(app, db);
  return app;
}

function setupRoutes(app: express.Express, db: import("dofek/db").Database) {
  // ── Compression + Cookies ──
  app.use(compression());
  app.use(cookieParser());

  // ── Prometheus metrics endpoint ──
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  // ── Request logging + metrics ──
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const durationMs = Date.now() - start;
      const route = req.route?.path ?? req.originalUrl.split("?")[0];
      httpRequestDuration.observe(
        { method: req.method, route, status_code: res.statusCode },
        durationMs / 1000,
      );
      logger.info(`[web] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
    });
    next();
  });

  // ── Apple Health upload state ──
  interface UploadChunks {
    received: Set<number>;
    total: number;
    dir: string;
  }
  interface JobStatus {
    status: "uploading" | "assembling" | "processing" | "done" | "error";
    progress?: number;
    message?: string;
    result?: any;
  }
  const activeUploads = new Map<string, UploadChunks>();
  const jobStatuses = new Map<string, JobStatus>();

  // Clean up completed jobs after 10 minutes
  function setJobStatus(id: string, status: JobStatus) {
    jobStatuses.set(id, status);
    if (status.status === "done" || status.status === "error") {
      setTimeout(() => jobStatuses.delete(id), 10 * 60 * 1000);
    }
  }

  // Background import — fires and forgets, updates jobStatuses as it runs
  function startBackgroundImport(jobId: string, filePath: string, since: Date) {
    logger.info("[apple-health] Starting import...");
    setJobStatus(jobId, { status: "processing", progress: 0, message: "Starting import..." });

    (async () => {
      const importStart = Date.now();
      try {
        const { importAppleHealthFile } = await import("dofek/providers/apple-health");
        let lastLoggedPct = 0;
        const result = await importAppleHealthFile(db, filePath, since, (info) => {
          setJobStatus(jobId, {
            status: "processing",
            progress: info.pct,
            message: `Processing: ${info.pct}%`,
          });
          // Log every 10% to avoid noise
          if (info.pct >= lastLoggedPct + 10) {
            logger.info(`[apple-health] Import progress: ${info.pct}%`);
            lastLoggedPct = info.pct;
          }
        });
        const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
        const msg = `${result.recordsSynced} records imported, ${result.errors?.length ?? 0} errors in ${durationSec}s`;
        logger.info(`[apple-health] Import complete: ${msg}`);
        setJobStatus(jobId, {
          status: "done",
          progress: 100,
          message: msg,
          result,
        });
        const { logSync } = await import("dofek/db/sync-log");
        await logSync(db, {
          providerId: "apple_health",
          dataType: "import",
          status: result.errors?.length ? "error" : "success",
          recordCount: result.recordsSynced,
          errorMessage: result.errors?.length
            ? result.errors.map((e: any) => e.message).join("; ")
            : undefined,
          durationMs: Date.now() - importStart,
        });
      } catch (err: any) {
        logger.error(`[upload] Background import failed: ${err}`);
        setJobStatus(jobId, {
          status: "error",
          message: err.message ?? "Import failed",
        });
        try {
          const { logSync } = await import("dofek/db/sync-log");
          await logSync(db, {
            providerId: "apple_health",
            dataType: "import",
            status: "error",
            errorMessage: err.message ?? "Import failed",
            durationMs: Date.now() - importStart,
          });
        } catch {}
      } finally {
        await unlink(filePath).catch(() => {});
      }
    })();
  }

  // Poll job status
  app.get("/api/upload/apple-health/status/:jobId", (req, res) => {
    const status = jobStatuses.get(req.params.jobId);
    if (!status) {
      res.status(404).json({ error: "Unknown job" });
      return;
    }
    res.json(status);
  });

  // Chunked upload endpoint
  app.post("/api/upload/apple-health", async (req, res) => {
    const uploadId = req.headers["x-upload-id"] as string | undefined;
    const chunkIndex = parseInt(req.headers["x-chunk-index"] as string, 10);
    const chunkTotal = parseInt(req.headers["x-chunk-total"] as string, 10);
    const fileExt = (req.headers["x-file-ext"] as string) || ".zip";
    const fullSync = req.query.fullSync === "true";
    const since = fullSync ? new Date(0) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Non-chunked upload (single small file) — still processes in background
    if (!uploadId || Number.isNaN(chunkTotal) || chunkTotal <= 1) {
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const ext = (req.headers["content-type"] ?? "").includes("xml") ? ".xml" : ".zip";
      const tmpFile = join(tmpdir(), `apple-health-${jobId}${ext}`);
      try {
        await streamToFile(req, tmpFile);
        startBackgroundImport(jobId, tmpFile, since);
        res.json({ status: "processing", jobId });
      } catch (err: any) {
        logger.error(`[upload] Apple Health upload failed: ${err}`);
        res.status(500).json({ error: err.message ?? "Upload failed" });
      }
      return;
    }

    // Chunked upload
    try {
      let upload = activeUploads.get(uploadId);
      if (!upload) {
        const dir = join(tmpdir(), `apple-health-chunked-${uploadId}`);
        await mkdir(dir, { recursive: true });
        upload = { received: new Set(), total: chunkTotal, dir };
        activeUploads.set(uploadId, upload);
        // Clean up abandoned uploads after 30 minutes
        setTimeout(
          async () => {
            const stale = activeUploads.get(uploadId);
            if (stale) {
              activeUploads.delete(uploadId);
              await rm(stale.dir, { recursive: true, force: true }).catch(() => {});
              setJobStatus(uploadId, { status: "error", message: "Upload timed out" });
            }
          },
          30 * 60 * 1000,
        );
        setJobStatus(uploadId, {
          status: "uploading",
          progress: 0,
          message: "Receiving chunks...",
        });
      }

      const chunkPath = join(upload.dir, `chunk-${String(chunkIndex).padStart(6, "0")}`);
      await streamToFile(req, chunkPath);
      upload.received.add(chunkIndex);

      const uploadPct = Math.round((upload.received.size / upload.total) * 100);
      logger.info(`[upload] Chunk ${chunkIndex + 1}/${chunkTotal} for ${uploadId}`);

      if (upload.received.size < upload.total) {
        setJobStatus(uploadId, {
          status: "uploading",
          progress: uploadPct,
          message: `Received ${upload.received.size}/${upload.total} chunks`,
        });
        res.json({
          status: "uploading",
          jobId: uploadId,
          received: upload.received.size,
          total: upload.total,
        });
        return;
      }

      // All chunks received — assemble then process in background
      setJobStatus(uploadId, { status: "assembling", progress: 0, message: "Assembling file..." });
      const assembledFile = join(tmpdir(), `apple-health-${uploadId}${fileExt}`);
      await assembleChunks(upload.dir, assembledFile);
      activeUploads.delete(uploadId);
      await rm(upload.dir, { recursive: true, force: true });

      startBackgroundImport(uploadId, assembledFile, since);
      res.json({ status: "processing", jobId: uploadId });
    } catch (err: any) {
      logger.error(`[upload] Chunked upload failed: ${err}`);
      const upload = activeUploads.get(uploadId);
      if (upload) {
        activeUploads.delete(uploadId);
        await rm(upload.dir, { recursive: true, force: true }).catch(() => {});
      }
      setJobStatus(uploadId, { status: "error", message: err.message ?? "Upload failed" });
      res.status(500).json({ error: err.message ?? "Upload failed" });
    }
  });

  // ── OAuth state ──
  // OAuth 1.0 request token secrets (keyed by oauth_token)
  const oauth1Secrets = new Map<string, { providerId: string; tokenSecret: string }>();

  // ── Identity auth routes (login with Google, Apple, Authentik) ──

  const IDENTITY_PROVIDERS: IdentityProviderName[] = ["google", "apple", "authentik"];

  app.get("/api/auth/providers", (_req, res) => {
    res.json(getConfiguredProviders());
  });

  app.get("/auth/login/:provider", (req, res) => {
    try {
      const providerName = req.params.provider as IdentityProviderName;
      if (!IDENTITY_PROVIDERS.includes(providerName)) {
        res.status(404).send(`Unknown identity provider: ${providerName}`);
        return;
      }
      if (!isProviderConfigured(providerName)) {
        res.status(400).send(`Provider ${providerName} is not configured`);
        return;
      }

      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const provider = getIdentityProvider(providerName);

      // Encode the provider name in the state so the callback knows which provider
      const statePayload = `${providerName}:${state}`;
      const url = provider.createAuthorizationUrl(statePayload, codeVerifier);

      setOAuthFlowCookies(res, statePayload, codeVerifier);
      res.redirect(url.toString());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Failed to start login flow: ${message}`);
      res.status(500).send(`Auth error: ${message}`);
    }
  });

  app.get("/auth/callback/:provider", async (req, res) => {
    try {
      const providerName = req.params.provider as IdentityProviderName;
      if (!IDENTITY_PROVIDERS.includes(providerName)) {
        res.status(404).send(`Unknown identity provider: ${providerName}`);
        return;
      }

      const code = req.query.code as string | undefined;
      const stateParam = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;

      if (error) {
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }
      if (!code || !stateParam) {
        res.status(400).send("Missing code or state parameter");
        return;
      }

      const { state: storedState, codeVerifier } = getOAuthFlowCookies(req);
      clearOAuthFlowCookies(res);

      if (!storedState || !codeVerifier || stateParam !== storedState) {
        res.status(400).send("Invalid state — please try logging in again");
        return;
      }

      // Validate the authorization code
      const provider = getIdentityProvider(providerName);
      const { user: identityUser } = await provider.validateCallback(code, codeVerifier);

      // Look up or create the user
      const existingAccount = await db.execute<{ user_id: string }>(
        sql`SELECT user_id FROM fitness.auth_account
            WHERE auth_provider = ${providerName} AND provider_account_id = ${identityUser.sub}
            LIMIT 1`,
      );

      let userId: string;

      if (existingAccount.length > 0) {
        userId = existingAccount[0].user_id;
      } else {
        // Check if this is the very first auth account (claim DEFAULT_USER_ID data)
        const accountCount = await db.execute<{ count: string }>(
          sql`SELECT COUNT(*)::text AS count FROM fitness.auth_account`,
        );
        const isFirstUser = parseInt(accountCount[0].count, 10) === 0;

        if (isFirstUser) {
          // First user — link to the default user profile and update it
          userId = DEFAULT_USER_ID;
          if (identityUser.email || identityUser.name) {
            await db.execute(
              sql`UPDATE fitness.user_profile
                  SET email = COALESCE(${identityUser.email}, email),
                      name = COALESCE(${identityUser.name}, name),
                      updated_at = NOW()
                  WHERE id = ${DEFAULT_USER_ID}`,
            );
          }
        } else {
          // New user — create a user profile
          const newUser = await db.execute<{ id: string }>(
            sql`INSERT INTO fitness.user_profile (name, email)
                VALUES (${identityUser.name ?? "User"}, ${identityUser.email})
                RETURNING id`,
          );
          userId = newUser[0].id;
        }

        // Create the auth account link
        await db.execute(
          sql`INSERT INTO fitness.auth_account (user_id, auth_provider, provider_account_id, email, name)
              VALUES (${userId}, ${providerName}, ${identityUser.sub}, ${identityUser.email}, ${identityUser.name})`,
        );
      }

      // Create session
      const sessionInfo = await createSession(db, userId);
      setSessionCookie(res, sessionInfo.sessionId, sessionInfo.expiresAt);

      logger.info(`[auth] User ${userId} logged in via ${providerName}`);
      res.redirect("/");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[auth] Identity callback failed: ${message}`);
      res.status(500).send(`Login failed: ${message}`);
    }
  });

  app.post("/auth/logout", async (req, res) => {
    const sessionId = getSessionCookie(req);
    if (sessionId) {
      await deleteSession(db, sessionId);
      clearSessionCookie(res);
    }
    res.json({ ok: true });
  });

  app.get("/api/auth/me", async (req, res) => {
    const sessionId = getSessionCookie(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const session = await validateSession(db, sessionId);
    if (!session) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Session expired" });
      return;
    }
    const rows = await db.execute<{ id: string; name: string; email: string | null }>(
      sql`SELECT id, name, email FROM fitness.user_profile WHERE id = ${session.userId}`,
    );
    if (rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json(rows[0]);
  });

  // ── Slack OAuth (Add to Slack) ──
  const SLACK_SCOPES = [
    "chat:write",
    "im:history",
    "im:read",
    "im:write",
    "users:read",
    "users:read.email",
  ];

  app.get("/auth/provider/slack", (_req, res) => {
    const clientId = process.env.SLACK_CLIENT_ID;
    if (!clientId) {
      res.status(400).send("SLACK_CLIENT_ID is not configured");
      return;
    }
    const redirectUri = `${process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback"}`;
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", SLACK_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", "slack");
    res.redirect(url.toString());
  });

  // ── Data-provider OAuth (Wahoo, Withings, etc.) ──
  app.get("/auth/provider/:provider", async (req, res) => {
    try {
      const providerId = req.params.provider;
      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("./routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === providerId);
      if (!provider) {
        res.status(404).send(`Unknown provider: ${providerId}`);
        return;
      }

      const setup = provider.authSetup?.();
      if (!setup?.oauthConfig) {
        res.status(400).send(`Provider ${providerId} does not use OAuth`);
        return;
      }

      // Providers with automatedLogin (e.g. Peloton) — run login server-side
      if (setup.automatedLogin) {
        const envPrefix = providerId.toUpperCase();
        const email = process.env[`${envPrefix}_USERNAME`];
        const password = process.env[`${envPrefix}_PASSWORD`];
        if (!email || !password) {
          res.status(400).send(`${envPrefix}_USERNAME and ${envPrefix}_PASSWORD must be set`);
          return;
        }

        logger.info(`[auth] Running automated login for ${providerId}...`);
        const tokens = await setup.automatedLogin(email, password);
        const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
        await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl);
        await saveTokens(db, provider.id, tokens);

        logger.info(
          `[auth] ${providerId} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`,
        );
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p>Token expires: ${tokens.expiresAt.toISOString()}</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      // OAuth 1.0 providers (e.g. FatSecret) — get request token first
      if ((setup as any).oauth1Flow) {
        const oauth1 = (setup as any).oauth1Flow;
        const callbackUrl = `${process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback"}`;
        const result = await oauth1.getRequestToken(callbackUrl);
        oauth1Secrets.set(result.oauthToken, {
          providerId,
          tokenSecret: result.oauthTokenSecret,
        });
        // Clean up after 10 minutes
        setTimeout(() => oauth1Secrets.delete(result.oauthToken), 10 * 60 * 1000);
        res.redirect(result.authorizeUrl);
        return;
      }

      const { buildAuthorizationUrl } = await import("dofek/auth/oauth");
      const url = buildAuthorizationUrl(setup.oauthConfig);
      // Append state so the callback knows which provider this is for
      const authUrl = new URL(url);
      authUrl.searchParams.set("state", providerId);
      res.redirect(authUrl.toString());
    } catch (err: any) {
      logger.error(`[auth] Failed to start OAuth flow: ${err}`);
      res.status(500).send(`Auth error: ${err.message}`);
    }
  });

  app.get("/callback", async (req, res) => {
    try {
      const code = req.query.code as string | undefined;
      const state = req.query.state as string | undefined;
      const error = req.query.error as string | undefined;
      const oauthToken = req.query.oauth_token as string | undefined;
      const oauthVerifier = req.query.oauth_verifier as string | undefined;

      // Bare GET with no params — providers (e.g. Withings) verify the URL is reachable
      if (!code && !state && !error && !oauthToken) {
        res.send("OK");
        return;
      }

      if (error) {
        res.status(400).send(`Authorization denied: ${error}`);
        return;
      }

      // ── OAuth 1.0 callback (FatSecret) ──
      if (oauthToken && oauthVerifier) {
        const stored = oauth1Secrets.get(oauthToken);
        if (!stored) {
          res.status(400).send("Unknown or expired OAuth 1.0 request token");
          return;
        }
        oauth1Secrets.delete(oauthToken);

        const { getAllProviders } = await import("dofek/providers/registry");
        const { ensureProvidersRegistered } = await import("./routers/sync.ts");
        await ensureProvidersRegistered();

        const provider = getAllProviders().find((p) => p.id === stored.providerId);
        if (!provider) {
          res.status(404).send(`Unknown provider: ${stored.providerId}`);
          return;
        }

        const setup = provider.authSetup?.();
        const oauth1Flow = (setup as any)?.oauth1Flow;
        if (!oauth1Flow) {
          res.status(400).send(`Provider ${stored.providerId} does not support OAuth 1.0`);
          return;
        }

        logger.info(`[auth] Exchanging OAuth 1.0 tokens for ${stored.providerId}...`);
        const { token, tokenSecret } = await oauth1Flow.exchangeForAccessToken(
          oauthToken,
          stored.tokenSecret,
          oauthVerifier,
        );

        const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
        await ensureProvider(db, provider.id, provider.name);
        // Store OAuth 1.0 tokens — token as accessToken, tokenSecret as refreshToken
        // OAuth 1.0 tokens don't expire
        await saveTokens(db, provider.id, {
          accessToken: token,
          refreshToken: tokenSecret,
          expiresAt: new Date("2099-12-31"),
          scopes: "",
        });

        logger.info(`[auth] ${stored.providerId} OAuth 1.0 tokens saved.`);
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      // ── OAuth 2.0 callback ──
      if (!code || !state) {
        res.status(400).send("Missing code or state parameter");
        return;
      }

      // ── Slack OAuth callback (Add to Slack) ──
      if (state === "slack") {
        const clientId = process.env.SLACK_CLIENT_ID;
        const clientSecret = process.env.SLACK_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          res.status(400).send("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set");
          return;
        }

        const redirectUri = `${process.env.OAUTH_REDIRECT_URI ?? "https://dofek.asherlc.com/callback"}`;
        logger.info("[auth] Exchanging Slack OAuth code for bot token...");

        // Exchange code for access token via Slack's oauth.v2.access
        const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenData = (await tokenResponse.json()) as {
          ok: boolean;
          error?: string;
          team?: { id: string; name: string };
          access_token?: string;
          bot_user_id?: string;
          app_id?: string;
          authed_user?: { id: string };
        };

        if (!tokenData.ok || !tokenData.access_token || !tokenData.team?.id) {
          res.status(400).send(`Slack OAuth failed: ${tokenData.error ?? "unknown error"}`);
          return;
        }

        // Store the installation
        await db.execute(
          sql`INSERT INTO fitness.slack_installation (
                team_id, team_name, bot_token, bot_user_id, app_id,
                installer_slack_user_id, raw_installation
              ) VALUES (
                ${tokenData.team.id},
                ${tokenData.team.name ?? null},
                ${tokenData.access_token},
                ${tokenData.bot_user_id ?? null},
                ${tokenData.app_id ?? null},
                ${tokenData.authed_user?.id ?? null},
                ${JSON.stringify(tokenData)}::jsonb
              )
              ON CONFLICT (team_id) DO UPDATE SET
                team_name = EXCLUDED.team_name,
                bot_token = EXCLUDED.bot_token,
                bot_user_id = EXCLUDED.bot_user_id,
                app_id = EXCLUDED.app_id,
                installer_slack_user_id = EXCLUDED.installer_slack_user_id,
                raw_installation = EXCLUDED.raw_installation,
                updated_at = NOW()`,
        );

        logger.info(
          `[auth] Slack installed for team ${tokenData.team.id} (${tokenData.team.name})`,
        );
        res.send(
          `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Slack Connected!</h1><p>Bot added to <strong>${tokenData.team.name}</strong>.</p><p>Send me a DM about what you ate!</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
        );
        return;
      }

      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("./routers/sync.ts");
      await ensureProvidersRegistered();

      const provider = getAllProviders().find((p) => p.id === state);
      if (!provider) {
        res.status(404).send(`Unknown provider: ${state}`);
        return;
      }

      const setup = provider.authSetup?.();
      if (!setup?.oauthConfig || !setup.exchangeCode) {
        res.status(400).send(`Provider ${state} does not support OAuth code exchange`);
        return;
      }

      logger.info(`[auth] Exchanging code for ${state} tokens...`);
      const tokens = await setup.exchangeCode(code);

      const { ensureProvider } = await import("dofek/db/tokens");
      const { saveTokens } = await import("dofek/db/tokens");
      await ensureProvider(db, provider.id, provider.name, setup.apiBaseUrl);
      await saveTokens(db, provider.id, tokens);

      logger.info(`[auth] ${state} tokens saved. Expires: ${tokens.expiresAt.toISOString()}`);
      res.send(
        `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>Authorized!</h1><p>${provider.name} connected successfully.</p><p>Token expires: ${tokens.expiresAt.toISOString()}</p><p><a href="/" style="color:#10b981">Return to dashboard</a></p></div></body></html>`,
      );
    } catch (err: any) {
      logger.error(`[auth] OAuth callback failed: ${err}`);
      res.status(500).send(`Token exchange failed: ${err.message}`);
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => {
        const sessionId = getSessionCookie(req);
        const session = sessionId ? await validateSession(db, sessionId) : null;
        return { db, userId: session?.userId ?? null };
      },
      allowMethodOverride: true,
    }),
  );
}

async function main() {
  // Auto-run pending migrations on startup
  await runMigrations(process.env.DATABASE_URL!);

  const db = createDatabaseFromEnv();
  const app = createApp(db);

  app.listen(PORT, () => {
    logger.info(`[server] API running at http://localhost:${PORT}`);
    logger.info(`[server] tRPC at http://localhost:${PORT}/api/trpc`);

    // Warm cache with common dashboard queries (fire-and-forget)
    warmCache(db).catch((err) => logger.error(`[cache] Warm failed: ${err}`));

    // Start Slack bot if configured (fire-and-forget)
    startSlackBot(db, app).catch((err) => logger.error(`[slack] Slack bot error: ${err}`));
  });
}

// Only start server when run directly (not imported for testing)
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main().catch((err: unknown) => {
    logger.error(`[web] Failed to start: ${err}`);
    process.exit(1);
  });
}
