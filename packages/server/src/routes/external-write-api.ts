import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database, TransactionDatabase } from "dofek/db";
import {
  AccountErasureIdentityFencedError,
  AccountErasureUserFencedError,
  withAccountErasureUserAndIdentityWriteFence,
} from "dofek/db/account-erasure";
import { captureException } from "dofek/lib/error-reporting";
import { sql } from "drizzle-orm";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { isAdmin } from "../auth/admin.ts";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { buildProblem, createOpaqueSecret, verifyPkce } from "./external-write-api-primitives.ts";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const LINK_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const scopes = ["nutrition:write"] as const;

const externalSubjectSchema = z.object({
  namespace: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(500),
});
const linkStartSchema = z.object({
  redirectUri: z.string().url(),
  codeChallenge: z.string().min(43).max(128),
  requestedScopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
  state: z.string().max(500).optional(),
});
const linkExchangeSchema = z.object({
  linkId: z.string().uuid(),
  code: z.string().min(20),
  codeVerifier: z.string().min(43).max(128),
  externalSubject: externalSubjectSchema,
});
const linkReissueSchema = externalSubjectSchema;
const authorizeSchema = z.object({
  linkId: z.string().uuid(),
  approved: z.union([z.literal(true), z.literal("true")]),
});
const nutritionSchema = z.object({
  entries: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meal: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
        foodName: z.string().min(1).max(500),
        foodDescription: z.string().max(2000).nullable().optional(),
        category: z.string().max(100).nullable().optional(),
        numberOfUnits: z.number().positive().nullable().optional(),
        externalId: z.string().min(1).max(500),
        nutrients: z.record(z.string(), z.number().nonnegative()),
      }),
    )
    .min(1)
    .max(100)
    .superRefine((entries, context) => {
      const firstDate = entries[0]?.date;
      if (firstDate && entries.some((entry) => entry.date !== firstDate)) {
        context.addIssue({ code: "custom", message: "All entries must use the same date." });
      }
    }),
});
const clientSchema = z.object({
  client_id: z.string(),
  scopes: z.array(z.string()),
  revoked_at: timestampStringSchema.nullable(),
});
const grantSchema = z.object({
  grant_id: z.string(),
  user_id: z.string(),
  scopes: z.array(z.string()),
  namespace: z.string(),
  subject: z.string(),
  expires_at: timestampStringSchema,
  revoked_at: timestampStringSchema.nullable(),
});
const reissueGrantSchema = z.object({
  grant_id: z.string(),
  user_id: z.string(),
  opaque_subject: z.string(),
  scopes: z.array(z.string()),
  namespace: z.string(),
  subject: z.string(),
});
const linkSchema = z.object({
  link_id: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  requested_scopes: z.array(z.string()),
  state: z.string().nullable(),
  expires_at: timestampStringSchema,
  user_id: z.string().nullable(),
  code_hash: z.string().nullable(),
  code_expires_at: timestampStringSchema.nullable(),
  approved_at: timestampStringSchema.nullable(),
  exchanged_at: timestampStringSchema.nullable(),
});
const receiptSchema = z.object({
  request_hash: z.string(),
  status: z.enum(["in_progress", "completed"]),
  response_json: z.unknown().nullable(),
});

function requestId(req: express.Request): string {
  return typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].length < 200
    ? req.headers["x-request-id"]
    : randomUUID();
}
function sendProblem(
  res: express.Response,
  req: express.Request,
  status: number,
  code: string,
  message?: string,
): void {
  const id = requestId(req);
  const problem = buildProblem(code, status, id);
  if (message) problem.message = message;
  res.status(status).json(problem);
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function clientCredential(req: express.Request): { clientId: string; secret: string } | null {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const value = header.slice(7).trim();
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  return { clientId: value.slice(0, separator), secret: value.slice(separator + 1) };
}
function accessToken(req: express.Request): string | null {
  const header = req.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}
function externalIdentity(namespace: string, subject: string) {
  return [
    {
      kind: "provider_account" as const,
      authProvider: `external:${namespace}`,
      providerAccountId: subject,
    },
  ];
}

function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function isAllowedRedirectUri(value: string): boolean {
  const uri = new URL(value);
  if (uri.username || uri.password || uri.hash) return false;
  if (uri.protocol === "https:") return true;
  return (
    process.env.NODE_ENV !== "production" &&
    uri.protocol === "http:" &&
    uri.hostname === "localhost"
  );
}

async function authenticateClient(db: Pick<Database, "execute">, req: express.Request) {
  const credentials = clientCredential(req);
  if (!credentials) return null;
  const rows = await executeWithSchema(
    db,
    clientSchema,
    sql`SELECT client_id, scopes, revoked_at FROM fitness.external_client WHERE client_id = ${credentials.clientId} LIMIT 1`,
  );
  const client = rows[0];
  const expectedHash = (
    await executeWithSchema(
      db,
      z.object({ secret_hash: z.string() }),
      sql`SELECT secret_hash FROM fitness.external_client WHERE client_id = ${credentials.clientId}`,
    )
  )[0]?.secret_hash;
  const actualHash = createHash("sha256").update(credentials.secret).digest("hex");
  if (
    !client ||
    client.revoked_at ||
    !expectedHash ||
    !timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash))
  )
    return null;
  return { ...client, clientId: credentials.clientId };
}

async function authenticateGrant(
  db: Pick<Database, "execute">,
  req: express.Request,
  requiredScope: string,
) {
  const token = accessToken(req);
  if (!token) return null;
  const rows = await executeWithSchema(
    db,
    grantSchema,
    sql`SELECT grant_id, user_id, scopes, namespace, subject, expires_at, revoked_at FROM fitness.external_grant WHERE access_token_hash = ${hash(token)} LIMIT 1`,
  );
  const grant = rows[0];
  if (
    !grant ||
    grant.revoked_at ||
    new Date(grant.expires_at).getTime() <= Date.now() ||
    !grant.scopes.includes(requiredScope)
  )
    return null;
  return grant;
}

async function currentSession(db: Database, req: express.Request) {
  const sessionId = getSessionIdFromRequest(req);
  return sessionId ? validateSession(db, sessionId) : null;
}

function authorizeHtml(linkId: string): string {
  return `<html><body><h1>Authorize Dofek external access</h1><p>This application is requesting nutrition write access.</p><form method="post" action="/api/external/v1/link/authorize"><input type="hidden" name="linkId" value="${linkId}"/><input type="hidden" name="approved" value="true"/><button type="submit">Approve</button></form></body></html>`;
}

export function createExternalWriteApiRouter(deps: { db: Database }): Router {
  const router = Router();

  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      message: "Too many rejected external API requests — please try again later",
    }),
  );

  router.post("/clients", express.json(), async (req, res) => {
    const session = await currentSession(deps.db, req);
    if (!session || !(await isAdmin(deps.db, session.userId)))
      return sendProblem(res, req, 403, "FORBIDDEN");
    const parsed = z
      .object({ name: z.string().min(1).max(200), scopes: z.array(z.enum(scopes)).min(1) })
      .safeParse(req.body);
    if (!parsed.success) return sendProblem(res, req, 422, "VALIDATION_ERROR");
    const clientId = `ext_${randomBytes(18).toString("base64url")}`;
    const secret = createOpaqueSecret();
    await deps.db.execute(
      sql`INSERT INTO fitness.external_client (client_id, name, secret_hash, scopes) VALUES (${clientId}, ${parsed.data.name}, ${secret.hash}, ${textArray(parsed.data.scopes)})`,
    );
    res.status(201).json({ clientId, clientSecret: secret.value, scopes: parsed.data.scopes });
  });

  router.post("/clients/:clientId/rotate", express.json(), async (req, res) => {
    const session = await currentSession(deps.db, req);
    if (!session || !(await isAdmin(deps.db, session.userId)))
      return sendProblem(res, req, 403, "FORBIDDEN");
    const secret = createOpaqueSecret();
    const result = await deps.db.execute(
      sql`UPDATE fitness.external_client
          SET secret_hash = ${secret.hash}, updated_at = NOW()
          WHERE client_id = ${req.params.clientId} AND revoked_at IS NULL
          RETURNING client_id`,
    );
    if (result.length !== 1) return sendProblem(res, req, 404, "NOT_FOUND");
    res.json({ clientId: req.params.clientId, clientSecret: secret.value });
  });

  router.post("/clients/:clientId/revoke", async (req, res) => {
    const session = await currentSession(deps.db, req);
    if (!session || !(await isAdmin(deps.db, session.userId)))
      return sendProblem(res, req, 403, "FORBIDDEN");
    await deps.db.execute(
      sql`UPDATE fitness.external_client SET revoked_at = NOW() WHERE client_id = ${req.params.clientId}`,
    );
    await deps.db.execute(
      sql`UPDATE fitness.external_grant SET revoked_at = NOW() WHERE client_id = ${req.params.clientId} AND revoked_at IS NULL`,
    );
    res.json({ revoked: true });
  });

  router.post("/link/start", express.json(), async (req, res) => {
    const client = await authenticateClient(deps.db, req);
    const parsed = linkStartSchema.safeParse(req.body);
    if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (
      !parsed.success ||
      !isAllowedRedirectUri(parsed.success ? parsed.data.redirectUri : "") ||
      parsed.data.requestedScopes.some((scope) => !client.scopes.includes(scope))
    )
      return sendProblem(res, req, 422, "VALIDATION_ERROR");
    const linkId = randomUUID();
    const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
    await deps.db.execute(
      sql`INSERT INTO fitness.external_link (link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at) VALUES (${linkId}::uuid, ${client.clientId}, ${parsed.data.redirectUri}, ${parsed.data.codeChallenge}, ${textArray(parsed.data.requestedScopes)}, ${parsed.data.state ?? null}, ${expiresAt})`,
    );
    const authorizationUrl = new URL(
      "/api/external/v1/link/authorize",
      `${req.protocol}://${req.get("host")}`,
    );
    authorizationUrl.searchParams.set("linkId", linkId);
    res.json({ linkId, authorizationUrl: authorizationUrl.toString(), expiresAt });
  });

  router.get("/link/authorize", async (req, res) => {
    const session = await currentSession(deps.db, req);
    const linkId = typeof req.query.linkId === "string" ? req.query.linkId : "";
    if (!session) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    const rows = await executeWithSchema(
      deps.db,
      linkSchema,
      sql`SELECT link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at, user_id, code_hash, code_expires_at, approved_at, exchanged_at FROM fitness.external_link WHERE link_id = ${linkId}::uuid LIMIT 1`,
    );
    const link = rows[0];
    if (!link || new Date(link.expires_at).getTime() <= Date.now() || link.exchanged_at)
      return sendProblem(res, req, 404, "NOT_FOUND");
    res.type("html").send(authorizeHtml(link.link_id));
  });

  router.post("/link/authorize", express.urlencoded({ extended: false }), async (req, res) => {
    const session = await currentSession(deps.db, req);
    const parsed = authorizeSchema.safeParse(req.body);
    if (!session || !parsed.success)
      return sendProblem(
        res,
        req,
        session ? 422 : 401,
        session ? "VALIDATION_ERROR" : "INVALID_CREDENTIALS",
      );
    const code = createOpaqueSecret().value;
    const codeHash = hash(code);
    const rows = await executeWithSchema(
      deps.db,
      linkSchema,
      sql`UPDATE fitness.external_link SET user_id = ${session.userId}, approved_at = NOW(), code_hash = ${codeHash}, code_expires_at = ${new Date(Date.now() + CODE_TTL_MS).toISOString()} WHERE link_id = ${parsed.data.linkId}::uuid AND expires_at > NOW() AND exchanged_at IS NULL RETURNING link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at, user_id, code_hash, code_expires_at, approved_at, exchanged_at`,
    );
    const link = rows[0];
    if (!link) return sendProblem(res, req, 404, "NOT_FOUND");
    const redirect = new URL(link.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("link_id", link.link_id);
    if (link.state) redirect.searchParams.set("state", link.state);
    res.redirect(303, redirect.toString());
  });

  router.post("/link/exchange", express.json(), async (req, res) => {
    const client = await authenticateClient(deps.db, req);
    const parsed = linkExchangeSchema.safeParse(req.body);
    if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (!parsed.success) return sendProblem(res, req, 422, "VALIDATION_ERROR");
    const rows = await executeWithSchema(
      deps.db,
      linkSchema,
      sql`SELECT link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at, user_id, code_hash, code_expires_at, approved_at, exchanged_at FROM fitness.external_link WHERE link_id = ${parsed.data.linkId}::uuid AND client_id = ${client.clientId} LIMIT 1`,
    );
    const link = rows[0];
    if (
      !link ||
      !link.user_id ||
      link.exchanged_at ||
      !link.code_hash ||
      !link.code_expires_at ||
      new Date(link.code_expires_at).getTime() <= Date.now() ||
      hash(parsed.data.code) !== link.code_hash ||
      !verifyPkce(parsed.data.codeVerifier, link.code_challenge)
    )
      return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    try {
      const result = await withAccountErasureUserAndIdentityWriteFence(
        deps.db,
        link.user_id,
        externalIdentity(
          parsed.data.externalSubject.namespace,
          parsed.data.externalSubject.subject,
        ),
        async (tx) => {
          const consumed = await executeWithSchema(
            tx,
            z.object({ link_id: z.string() }),
            sql`UPDATE fitness.external_link
                SET exchanged_at = NOW()
                WHERE link_id = ${link.link_id}::uuid
                  AND exchanged_at IS NULL
                  AND code_hash = ${link.code_hash}
                  AND code_expires_at > NOW()
                RETURNING link_id`,
          );
          if (!consumed[0]) throw new Error("INVALID_LINK_CODE");
          const existing = await executeWithSchema(
            tx,
            z.object({ user_id: z.string(), opaque_subject: z.string() }),
            sql`SELECT user_id, opaque_subject FROM fitness.external_identity_link WHERE namespace = ${parsed.data.externalSubject.namespace} AND subject = ${parsed.data.externalSubject.subject} LIMIT 1`,
          );
          if (existing[0] && existing[0].user_id !== link.user_id)
            throw new Error("EXTERNAL_IDENTITY_ALREADY_LINKED");
          const grantId = randomUUID();
          const token = createOpaqueSecret();
          const opaqueSubject = existing[0]?.opaque_subject ?? createOpaqueSecret().value;
          await tx.execute(
            sql`INSERT INTO fitness.external_identity_link (namespace, subject, user_id, opaque_subject) VALUES (${parsed.data.externalSubject.namespace}, ${parsed.data.externalSubject.subject}, ${link.user_id}, ${opaqueSubject}) ON CONFLICT (namespace, subject) DO UPDATE SET user_id = EXCLUDED.user_id`,
          );
          await tx.execute(
            sql`INSERT INTO fitness.external_grant (grant_id, client_id, user_id, namespace, subject, opaque_subject, access_token_hash, scopes, expires_at) VALUES (${grantId}::uuid, ${client.clientId}, ${link.user_id}, ${parsed.data.externalSubject.namespace}, ${parsed.data.externalSubject.subject}, ${opaqueSubject}, ${hash(token.value)}, ${link.requested_scopes}, ${new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString()})`,
          );
          return {
            opaqueSubject,
            grantId,
            token: token.value,
            scope: link.requested_scopes.join(" "),
          };
        },
      );
      res.json({
        externalSubject: result.opaqueSubject,
        grantId: result.grantId,
        accessToken: result.token,
        tokenType: "Bearer",
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        scope: result.scope,
      });
    } catch (error) {
      if (
        error instanceof AccountErasureUserFencedError ||
        error instanceof AccountErasureIdentityFencedError
      )
        return sendProblem(res, req, 423, "ACCOUNT_ERASURE_ACTIVE");
      if (error instanceof Error && error.message === "EXTERNAL_IDENTITY_ALREADY_LINKED")
        return sendProblem(res, req, 409, "EXTERNAL_IDENTITY_ALREADY_LINKED");
      if (error instanceof Error && error.message === "INVALID_LINK_CODE")
        return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
      captureException(error);
      logger.error(
        `[external-api] link exchange failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return sendProblem(res, req, 503, "SERVICE_UNAVAILABLE");
    }
  });

  router.post("/link/reissue", express.json(), async (req, res) => {
    const client = await authenticateClient(deps.db, req);
    const parsed = linkReissueSchema.safeParse(req.body);
    if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (!parsed.success) return sendProblem(res, req, 422, "VALIDATION_ERROR");

    const grants = await executeWithSchema(
      deps.db,
      reissueGrantSchema,
      sql`SELECT grant_id, user_id, opaque_subject, scopes, namespace, subject
          FROM fitness.external_grant
          WHERE client_id = ${client.clientId}
            AND namespace = ${parsed.data.namespace}
            AND subject = ${parsed.data.subject}
            AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1`,
    );
    const grant = grants[0];
    if (!grant) return sendProblem(res, req, 404, "NOT_FOUND");

    try {
      const result = await withAccountErasureUserAndIdentityWriteFence(
        deps.db,
        grant.user_id,
        externalIdentity(grant.namespace, grant.subject),
        async (tx) => {
          const token = createOpaqueSecret();
          const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
          const rotated = await executeWithSchema(
            tx,
            reissueGrantSchema,
            sql`UPDATE fitness.external_grant
                SET access_token_hash = ${hash(token.value)}, expires_at = ${expiresAt}
                WHERE grant_id = ${grant.grant_id}::uuid
                  AND client_id = ${client.clientId}
                  AND namespace = ${grant.namespace}
                  AND subject = ${grant.subject}
                  AND revoked_at IS NULL
                RETURNING grant_id, user_id, opaque_subject, scopes, namespace, subject`,
          );
          if (!rotated[0]) throw new Error("GRANT_NOT_FOUND");
          return {
            externalSubject: rotated[0].opaque_subject,
            grantId: rotated[0].grant_id,
            accessToken: token.value,
            tokenType: "Bearer" as const,
            expiresIn: ACCESS_TOKEN_TTL_SECONDS,
            scope: rotated[0].scopes.join(" "),
          };
        },
      );
      return res.json(result);
    } catch (error) {
      if (
        error instanceof AccountErasureUserFencedError ||
        error instanceof AccountErasureIdentityFencedError
      )
        return sendProblem(res, req, 423, "ACCOUNT_ERASURE_ACTIVE");
      if (error instanceof Error && error.message === "GRANT_NOT_FOUND")
        return sendProblem(res, req, 404, "NOT_FOUND");
      captureException(error);
      logger.error(
        `[external-api] link reissue failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return sendProblem(res, req, 503, "SERVICE_UNAVAILABLE");
    }
  });

  router.post("/link/status", express.json(), async (req, res) => {
    const client = await authenticateClient(deps.db, req);
    const parsed = externalSubjectSchema.safeParse(req.body);
    if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (!parsed.success) return sendProblem(res, req, 422, "VALIDATION_ERROR");
    const rows = await executeWithSchema(
      deps.db,
      z.object({
        opaque_subject: z.string(),
        grant_id: z.string(),
        revoked_at: timestampStringSchema.nullable(),
      }),
      sql`SELECT link.opaque_subject, grant.grant_id, grant.revoked_at FROM fitness.external_identity_link link JOIN fitness.external_grant grant ON grant.namespace = link.namespace AND grant.subject = link.subject WHERE link.namespace = ${parsed.data.namespace} AND link.subject = ${parsed.data.subject} AND grant.client_id = ${client.clientId} ORDER BY grant.created_at DESC LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return res.status(404).json(buildProblem("NOT_FOUND", 404, requestId(req)));
    res.json({
      status: row.revoked_at ? "revoked" : "linked",
      externalSubject: row.opaque_subject,
      grantId: row.grant_id,
    });
  });

  router.post("/nutrition/entries", express.json(), async (req, res) => {
    const grant = await authenticateGrant(deps.db, req, "nutrition:write");
    const parsed = nutritionSchema.safeParse(req.body);
    const key = req.get("Idempotency-Key");
    if (!grant) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (!key || key.length < 16 || key.length > 200 || !parsed.success)
      return sendProblem(res, req, 422, "VALIDATION_ERROR");
    const path = "/api/external/v1/nutrition/entries";
    const bodyHash = hash(parsed.data);
    const firstDate = parsed.data.entries[0]?.date;
    if (!firstDate) return sendProblem(res, req, 422, "VALIDATION_ERROR");
    const existing = await executeWithSchema(
      deps.db,
      receiptSchema,
      sql`SELECT request_hash, status, response_json FROM fitness.external_idempotency_receipt WHERE grant_id = ${grant.grant_id}::uuid AND method = 'POST' AND path = ${path} AND idempotency_key = ${key} LIMIT 1`,
    );
    if (existing[0]) {
      if (existing[0].request_hash !== bodyHash)
        return sendProblem(res, req, 409, "IDEMPOTENCY_KEY_REUSED");
      if (existing[0].status === "in_progress")
        return sendProblem(res, req, 409, "REQUEST_IN_PROGRESS");
      return res.json(existing[0].response_json);
    }
    const inserted = await deps.db.execute(
      sql`INSERT INTO fitness.external_idempotency_receipt (grant_id, method, path, idempotency_key, request_hash, status) VALUES (${grant.grant_id}::uuid, 'POST', ${path}, ${key}, ${bodyHash}, 'in_progress') ON CONFLICT DO NOTHING`,
    );
    if (inserted.length !== 1) return sendProblem(res, req, 409, "REQUEST_IN_PROGRESS");
    try {
      const response = await withAccountErasureUserAndIdentityWriteFence(
        deps.db,
        grant.user_id,
        externalIdentity(grant.namespace, grant.subject),
        async (tx: TransactionDatabase) => {
          const repo = new FoodRepository(tx, grant.user_id, "UTC");
          const entries = [];
          for (const entry of parsed.data.entries)
            entries.push(await repo.create({ ...entry, externalId: entry.externalId }));
          const calorieGoal = await new SettingsRepository(tx, grant.user_id).getCalorieGoal();
          const nutrition = await repo.nutritionByDate(firstDate, calorieGoal);
          return {
            entries: entries.map((entry) => ({ id: entry.id, externalId: entry.external_id })),
            dailyIntake: {
              date: firstDate,
              state: nutrition.summary ? "available" : "unavailable",
              summary: nutrition.summary,
              resolution: nutrition.resolution,
            },
          };
        },
      );
      await deps.db.execute(
        sql`UPDATE fitness.external_idempotency_receipt SET status = 'completed', response_json = ${JSON.stringify(response)}::jsonb, completed_at = NOW() WHERE grant_id = ${grant.grant_id}::uuid AND method = 'POST' AND path = ${path} AND idempotency_key = ${key}`,
      );
      res.json(response);
    } catch (error) {
      if (
        error instanceof AccountErasureUserFencedError ||
        error instanceof AccountErasureIdentityFencedError
      ) {
        await deps.db.execute(
          sql`DELETE FROM fitness.external_idempotency_receipt WHERE grant_id = ${grant.grant_id}::uuid AND method = 'POST' AND path = ${path} AND idempotency_key = ${key}`,
        );
        return sendProblem(res, req, 423, "ACCOUNT_ERASURE_ACTIVE");
      }
      await deps.db.execute(
        sql`DELETE FROM fitness.external_idempotency_receipt WHERE grant_id = ${grant.grant_id}::uuid AND method = 'POST' AND path = ${path} AND idempotency_key = ${key}`,
      );
      captureException(error);
      logger.error(
        `[external-api] nutrition write failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return sendProblem(res, req, 503, "SERVICE_UNAVAILABLE");
    }
  });

  router.post("/erasure/ack", express.json(), async (req, res) => {
    const grant = await authenticateGrant(deps.db, req, "nutrition:write");
    const parsed = z
      .object({
        eventId: z.string().min(1),
        result: z.enum(["completed", "failed"]),
        reasonCode: z.string().max(200).optional(),
      })
      .safeParse(req.body);
    if (!grant) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (!parsed.success) return sendProblem(res, req, 422, "VALIDATION_ERROR");
    await deps.db.execute(
      sql`INSERT INTO fitness.external_erasure_ack (event_id, grant_id, result, reason_code) VALUES (${parsed.data.eventId}, ${grant.grant_id}::uuid, ${parsed.data.result}, ${parsed.data.reasonCode ?? null}) ON CONFLICT (event_id) DO UPDATE SET result = EXCLUDED.result, reason_code = EXCLUDED.reason_code, acknowledged_at = NOW()`,
    );
    res.json({ accepted: true });
  });
  return router;
}
