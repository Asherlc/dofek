import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalizeDeveloperRedirectUri } from "@dofek/auth/developer-clients";
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
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { DeveloperClientRepository } from "../repositories/developer-client-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { SettingsRepository } from "../repositories/settings-repository.ts";
import { buildProblem, sendApiProblem } from "./api-problem.ts";
import { createOpaqueSecret, hashSecret, verifyPkce } from "./external-write-api-primitives.ts";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const LINK_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const scopes = ["nutrition:write"] as const;

const externalSubjectSchema = z.object({
  namespace: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(500),
});
const linkStartSchema = z.object({
  redirectUri: z.url(),
  codeChallenge: z.string().min(43).max(128),
  requestedScopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
  state: z.string().max(500).optional(),
});
const linkExchangeSchema = z.object({
  linkId: z.uuid(),
  code: z.string().min(20),
  codeVerifier: z.string().min(43).max(128),
  externalSubject: externalSubjectSchema,
});
const linkReissueSchema = externalSubjectSchema;
const authorizeSchema = z.object({
  linkId: z.uuid(),
  approved: z.union([z.literal(true), z.literal("true")]),
  csrfToken: z.string().min(43).max(128),
});
const nutritionSchema = z.object({
  entries: z
    .array(
      z.object({
        date: z.iso.date(),
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
  secret_hash: z.string(),
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
  access_token_hash: z.string(),
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
  approval_csrf_hash: z.string().nullable(),
  approval_session_hash: z.string().nullable(),
});
const receiptSchema = z.object({
  request_hash: z.string(),
  status: z.enum(["in_progress", "completed"]),
  response_json: z.unknown().nullable(),
});
const receiptResponseSchema = z.object({
  entries: z.array(z.object({ id: z.string(), externalId: z.string() })),
  date: z.iso.date(),
});
const idempotencyKeySchema = z.string().min(16).max(200);
const requestIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);

function requestId(req: express.Request): string {
  const parsed = requestIdSchema.safeParse(req.headers["x-request-id"]);
  return parsed.success ? parsed.data : randomUUID();
}
function sendProblem(
  res: express.Response,
  req: express.Request,
  status: number,
  code: string,
  message?: string,
  details: unknown[] = [],
): void {
  const id = res.locals.externalRequestId ?? requestId(req);
  if (message) {
    res.status(status).json({ ...buildProblem(code, status, id, details), message });
    return;
  }
  sendApiProblem(res, id, status, code, details);
}

function validationDetails(
  error: z.ZodError,
): Array<{ path: (string | number)[]; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    ),
    message: issue.message,
  }));
}
function hashRequestBody(value: unknown): string {
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

function isExternalIdConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (
    "code" in error &&
    error.code === "23505" &&
    (("constraint" in error && error.constraint === "food_entry_provider_external_idx") ||
      ("constraint_name" in error && error.constraint_name === "food_entry_provider_external_idx"))
  );
}

async function authenticateClient(db: Pick<Database, "execute">, req: express.Request) {
  const credentials = clientCredential(req);
  if (!credentials) return null;
  const rows = await executeWithSchema(
    db,
    clientSchema,
    sql`SELECT client_id, secret_hash, scopes, revoked_at FROM fitness.external_client WHERE client_id = ${credentials.clientId} LIMIT 1`,
  );
  const client = rows[0];
  const expectedHash = client?.secret_hash;
  const actualHash = hashSecret(credentials.secret);
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
    sql`SELECT grant_id, user_id, scopes, namespace, subject, expires_at, revoked_at FROM fitness.external_grant WHERE access_token_hash = ${hashSecret(token)} LIMIT 1`,
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

function authorizeHtml(linkId: string, csrfToken: string): string {
  return `<html><body><h1>Authorize Dofek external access</h1><p>This application is requesting nutrition write access.</p><form method="post" action="/api/external/v1/link/authorize"><input type="hidden" name="linkId" value="${linkId}"/><input type="hidden" name="approved" value="true"/><input type="hidden" name="csrfToken" value="${csrfToken}"/><button type="submit">Approve</button></form></body></html>`;
}

function handleExternalErrors(
  label: string,
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return next(error);
      captureException(error);
      logger.error(
        `[external-api] ${label} failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      sendProblem(res, req, 503, "SERVICE_UNAVAILABLE");
    }
  };
}

export function createExternalWriteApiRouter(deps: { db: Database }): Router {
  const router = Router();
  const developerClients = new DeveloperClientRepository(deps.db);
  const linkStartRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    handler: (request, response) => {
      sendProblem(response, request, 429, "RATE_LIMITED");
    },
  });

  router.use((req, res, next) => {
    res.locals.externalRequestId = requestId(req);
    next();
  });
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      skip: (request) => request.path === "/link/start",
      handler: (request, response) => {
        sendProblem(response, request, 429, "RATE_LIMITED");
      },
    }),
  );

  router.post(
    "/link/start",
    express.json(),
    (request, response, next) => {
      linkStartRateLimit(request, response, next);
    },
    handleExternalErrors("link start", async (req, res) => {
      const client = await authenticateClient(deps.db, req);
      if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
      const parsed = linkStartSchema.safeParse(req.body);
      if (!parsed.success)
        return sendProblem(
          res,
          req,
          422,
          "VALIDATION_ERROR",
          undefined,
          validationDetails(parsed.error),
        );
      let canonicalRedirectUri: string;
      try {
        canonicalRedirectUri = canonicalizeDeveloperRedirectUri(parsed.data.redirectUri);
      } catch {
        return sendProblem(res, req, 422, "VALIDATION_ERROR");
      }
      if (parsed.data.redirectUri !== canonicalRedirectUri)
        return sendProblem(res, req, 422, "VALIDATION_ERROR");
      if (parsed.data.requestedScopes.some((scope) => !client.scopes.includes(scope)))
        return sendProblem(res, req, 422, "VALIDATION_ERROR");
      if (!(await developerClients.hasExactRedirect(client.clientId, parsed.data.redirectUri)))
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
    }),
  );

  router.get(
    "/link/authorize",
    handleExternalErrors("link authorization page", async (req, res) => {
      const session = await currentSession(deps.db, req);
      if (!session) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
      const sessionId = getSessionIdFromRequest(req);
      if (!sessionId) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
      const parsedLinkId = z.uuid().safeParse(req.query.linkId);
      if (!parsedLinkId.success) return sendProblem(res, req, 404, "NOT_FOUND");
      const csrfToken = createOpaqueSecret();
      const rows = await executeWithSchema(
        deps.db,
        linkSchema,
        sql`UPDATE fitness.external_link
          SET approval_csrf_hash = ${csrfToken.hash}, approval_session_hash = ${hashSecret(sessionId)}
          WHERE link_id = ${parsedLinkId.data}::uuid AND expires_at > NOW() AND exchanged_at IS NULL
          RETURNING link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at, user_id, code_hash, code_expires_at, approved_at, exchanged_at, approval_csrf_hash, approval_session_hash`,
      );
      const link = rows[0];
      if (!link || new Date(link.expires_at).getTime() <= Date.now() || link.exchanged_at)
        return sendProblem(res, req, 404, "NOT_FOUND");
      res.type("html").send(authorizeHtml(link.link_id, csrfToken.value));
    }),
  );

  router.post(
    "/link/authorize",
    express.urlencoded({ extended: false }),
    handleExternalErrors("link authorization", async (req, res) => {
      const session = await currentSession(deps.db, req);
      const sessionId = getSessionIdFromRequest(req);
      const parsed = authorizeSchema.safeParse(req.body);
      if (!session || !parsed.success)
        return sendProblem(
          res,
          req,
          session ? 422 : 401,
          session ? "VALIDATION_ERROR" : "INVALID_CREDENTIALS",
          undefined,
          session && !parsed.success ? validationDetails(parsed.error) : [],
        );
      const code = createOpaqueSecret().value;
      const codeHash = hashSecret(code);
      const rows = await executeWithSchema(
        deps.db,
        linkSchema,
        sql`UPDATE fitness.external_link SET user_id = ${session.userId}, approved_at = NOW(), code_hash = ${codeHash}, code_expires_at = ${new Date(Date.now() + CODE_TTL_MS).toISOString()}, approval_csrf_hash = NULL, approval_session_hash = NULL WHERE link_id = ${parsed.data.linkId}::uuid AND expires_at > NOW() AND exchanged_at IS NULL AND approval_csrf_hash = ${hashSecret(parsed.data.csrfToken)} AND approval_session_hash = ${sessionId ? hashSecret(sessionId) : null} RETURNING link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at, user_id, code_hash, code_expires_at, approved_at, exchanged_at, approval_csrf_hash, approval_session_hash`,
      );
      const link = rows[0];
      if (!link) return sendProblem(res, req, 404, "NOT_FOUND");
      const redirect = new URL(link.redirect_uri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("link_id", link.link_id);
      if (link.state) redirect.searchParams.set("state", link.state);
      res.redirect(303, redirect.toString());
    }),
  );

  router.post("/link/exchange", express.json(), async (req, res) => {
    const client = await authenticateClient(deps.db, req);
    const parsed = linkExchangeSchema.safeParse(req.body);
    if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    if (!parsed.success)
      return sendProblem(
        res,
        req,
        422,
        "VALIDATION_ERROR",
        undefined,
        validationDetails(parsed.error),
      );
    const rows = await executeWithSchema(
      deps.db,
      linkSchema,
      sql`SELECT link_id, client_id, redirect_uri, code_challenge, requested_scopes, state, expires_at, user_id, code_hash, code_expires_at, approved_at, exchanged_at, approval_csrf_hash, approval_session_hash FROM fitness.external_link WHERE link_id = ${parsed.data.linkId}::uuid AND client_id = ${client.clientId} LIMIT 1`,
    );
    const link = rows[0];
    if (
      !link ||
      !link.user_id ||
      link.exchanged_at ||
      !link.code_hash ||
      !link.code_expires_at ||
      new Date(link.code_expires_at).getTime() <= Date.now() ||
      hashSecret(parsed.data.code) !== link.code_hash ||
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
            sql`SELECT user_id, opaque_subject
                FROM fitness.external_identity_link
                WHERE namespace = ${parsed.data.externalSubject.namespace}
                  AND subject = ${parsed.data.externalSubject.subject}
                LIMIT 1
                FOR UPDATE`,
          );
          if (existing[0] && existing[0].user_id !== link.user_id)
            throw new Error("EXTERNAL_IDENTITY_ALREADY_LINKED");
          const grantId = randomUUID();
          const token = createOpaqueSecret();
          const opaqueSubject = existing[0]?.opaque_subject ?? createOpaqueSecret().value;
          const linked = await executeWithSchema(
            tx,
            z.object({ user_id: z.string() }),
            sql`INSERT INTO fitness.external_identity_link (namespace, subject, user_id, opaque_subject)
                VALUES (${parsed.data.externalSubject.namespace}, ${parsed.data.externalSubject.subject}, ${link.user_id}, ${opaqueSubject})
                ON CONFLICT (namespace, subject) DO UPDATE
                  SET user_id = EXCLUDED.user_id
                  WHERE fitness.external_identity_link.user_id = EXCLUDED.user_id
                RETURNING user_id`,
          );
          if (!linked[0]) throw new Error("EXTERNAL_IDENTITY_ALREADY_LINKED");
          await tx.execute(
            sql`INSERT INTO fitness.external_grant (grant_id, client_id, user_id, namespace, subject, opaque_subject, access_token_hash, scopes, expires_at) VALUES (${grantId}::uuid, ${client.clientId}, ${link.user_id}, ${parsed.data.externalSubject.namespace}, ${parsed.data.externalSubject.subject}, ${opaqueSubject}, ${hashSecret(token.value)}, ${textArray(link.requested_scopes)}, ${new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString()})`,
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
    if (!parsed.success)
      return sendProblem(
        res,
        req,
        422,
        "VALIDATION_ERROR",
        undefined,
        validationDetails(parsed.error),
      );

    const grants = await executeWithSchema(
      deps.db,
      reissueGrantSchema,
      sql`SELECT grant_id, user_id, opaque_subject, access_token_hash, scopes, namespace, subject
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
                SET access_token_hash = ${hashSecret(token.value)}, expires_at = ${expiresAt}
                WHERE grant_id = ${grant.grant_id}::uuid
                  AND client_id = ${client.clientId}
                  AND namespace = ${grant.namespace}
                  AND subject = ${grant.subject}
                  AND access_token_hash = ${grant.access_token_hash}
                  AND revoked_at IS NULL
                RETURNING grant_id, user_id, opaque_subject, access_token_hash, scopes, namespace, subject`,
          );
          if (!rotated[0]) {
            const current = await executeWithSchema(
              tx,
              z.object({ access_token_hash: z.string() }),
              sql`SELECT access_token_hash
                  FROM fitness.external_grant
                  WHERE grant_id = ${grant.grant_id}::uuid
                    AND client_id = ${client.clientId}
                    AND namespace = ${grant.namespace}
                    AND subject = ${grant.subject}
                    AND revoked_at IS NULL
                  LIMIT 1`,
            );
            if (!current[0]) throw new Error("GRANT_NOT_FOUND");
            throw new Error("GRANT_REISSUE_CONFLICT");
          }
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
      if (error instanceof Error && error.message === "GRANT_REISSUE_CONFLICT")
        return sendProblem(res, req, 409, "REQUEST_IN_PROGRESS");
      captureException(error);
      logger.error(
        `[external-api] link reissue failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return sendProblem(res, req, 503, "SERVICE_UNAVAILABLE");
    }
  });

  router.post(
    "/link/status",
    express.json(),
    handleExternalErrors("link status", async (req, res) => {
      const client = await authenticateClient(deps.db, req);
      const parsed = externalSubjectSchema.safeParse(req.body);
      if (!client) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
      if (!parsed.success)
        return sendProblem(
          res,
          req,
          422,
          "VALIDATION_ERROR",
          undefined,
          validationDetails(parsed.error),
        );
      const rows = await executeWithSchema(
        deps.db,
        z.object({
          opaque_subject: z.string(),
          grant_id: z.string(),
          revoked_at: timestampStringSchema.nullable(),
        }),
        sql`SELECT link.opaque_subject, g.grant_id, g.revoked_at FROM fitness.external_identity_link link JOIN fitness.external_grant g ON g.namespace = link.namespace AND g.subject = link.subject WHERE link.namespace = ${parsed.data.namespace} AND link.subject = ${parsed.data.subject} AND g.client_id = ${client.clientId} ORDER BY g.created_at DESC LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return sendProblem(res, req, 404, "NOT_FOUND");
      res.json({
        status: row.revoked_at ? "revoked" : "linked",
        externalSubject: row.opaque_subject,
        grantId: row.grant_id,
      });
    }),
  );

  router.post("/nutrition/entries", express.json(), async (req, res) => {
    const grant = await authenticateGrant(deps.db, req, "nutrition:write");
    const parsed = nutritionSchema.safeParse(req.body);
    if (!grant) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
    const parsedKey = idempotencyKeySchema.safeParse(req.get("Idempotency-Key"));
    if (!parsedKey.success)
      return sendProblem(
        res,
        req,
        422,
        "VALIDATION_ERROR",
        "The Idempotency-Key header is invalid.",
      );
    if (!parsed.success)
      return sendProblem(
        res,
        req,
        422,
        "VALIDATION_ERROR",
        undefined,
        validationDetails(parsed.error),
      );
    const key = parsedKey.data;
    const path = "/api/external/v1/nutrition/entries";
    const bodyHash = hashRequestBody(parsed.data);
    const firstDate = parsed.data.entries[0]?.date;
    if (!firstDate) return sendProblem(res, req, 422, "VALIDATION_ERROR");
    await deps.db.execute(
      sql`DELETE FROM fitness.external_idempotency_receipt WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '7 days'`,
    );
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
      const replay = receiptResponseSchema.safeParse(existing[0].response_json);
      if (!replay.success) return res.json(existing[0].response_json);
      const calorieGoal = await new SettingsRepository(deps.db, grant.user_id).getCalorieGoal();
      const nutrition = await new FoodRepository(deps.db, grant.user_id, "UTC").nutritionByDate(
        replay.data.date,
        calorieGoal,
      );
      return res.json({
        entries: replay.data.entries,
        dailyIntake: {
          date: replay.data.date,
          state: nutrition.summary ? "available" : "unavailable",
          summary: nutrition.summary,
          resolution: nutrition.resolution,
        },
      });
    }
    try {
      const response = await withAccountErasureUserAndIdentityWriteFence(
        deps.db,
        grant.user_id,
        externalIdentity(grant.namespace, grant.subject),
        async (tx: TransactionDatabase) => {
          const inserted = await executeWithSchema(
            tx,
            z.object({ grant_id: z.string() }),
            sql`INSERT INTO fitness.external_idempotency_receipt (grant_id, method, path, idempotency_key, request_hash, status) VALUES (${grant.grant_id}::uuid, 'POST', ${path}, ${key}, ${bodyHash}, 'in_progress') ON CONFLICT DO NOTHING RETURNING grant_id`,
          );
          if (!inserted[0]) throw new Error("REQUEST_IN_PROGRESS");
          const repo = new FoodRepository(tx, grant.user_id, "UTC");
          const entries = [];
          for (const entry of parsed.data.entries)
            entries.push(await repo.create({ ...entry, externalId: entry.externalId }));
          const calorieGoal = await new SettingsRepository(tx, grant.user_id).getCalorieGoal();
          const nutrition = await repo.nutritionByDate(firstDate, calorieGoal);
          const response = {
            entries: entries.map((entry) => ({ id: entry.id, externalId: entry.external_id })),
            dailyIntake: {
              date: firstDate,
              state: nutrition.summary ? "available" : "unavailable",
              summary: nutrition.summary,
              resolution: nutrition.resolution,
            },
          };
          const completed = await executeWithSchema(
            tx,
            z.object({ grant_id: z.string() }),
            sql`UPDATE fitness.external_idempotency_receipt
                SET status = 'completed',
                    response_json = ${JSON.stringify({ entries: response.entries, date: firstDate })}::jsonb,
                    completed_at = NOW()
                WHERE grant_id = ${grant.grant_id}::uuid
                  AND method = 'POST'
                  AND path = ${path}
                  AND idempotency_key = ${key}
                  AND status = 'in_progress'
                RETURNING grant_id`,
          );
          if (!completed[0]) throw new Error("REQUEST_IN_PROGRESS");
          return response;
        },
      );
      res.json(response);
    } catch (error) {
      if (
        error instanceof AccountErasureUserFencedError ||
        error instanceof AccountErasureIdentityFencedError
      ) {
        return sendProblem(res, req, 423, "ACCOUNT_ERASURE_ACTIVE");
      }
      if (error instanceof Error && error.message === "REQUEST_IN_PROGRESS")
        return sendProblem(res, req, 409, "REQUEST_IN_PROGRESS");
      if (isExternalIdConflict(error)) {
        return sendProblem(res, req, 409, "EXTERNAL_ID_ALREADY_EXISTS");
      }
      captureException(error);
      logger.error(
        `[external-api] nutrition write failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return sendProblem(res, req, 503, "SERVICE_UNAVAILABLE");
    }
  });

  router.post(
    "/erasure/ack",
    express.json(),
    handleExternalErrors("erasure acknowledgement", async (req, res) => {
      const grant = await authenticateGrant(deps.db, req, "nutrition:write");
      const parsed = z
        .object({
          eventId: z.string().min(1),
          result: z.enum(["completed", "failed"]),
          reasonCode: z.string().max(200).optional(),
        })
        .safeParse(req.body);
      if (!grant) return sendProblem(res, req, 401, "INVALID_CREDENTIALS");
      if (!parsed.success)
        return sendProblem(
          res,
          req,
          422,
          "VALIDATION_ERROR",
          undefined,
          validationDetails(parsed.error),
        );
      await deps.db.execute(
        sql`INSERT INTO fitness.external_erasure_ack (event_id, grant_id, result, reason_code) VALUES (${parsed.data.eventId}, ${grant.grant_id}::uuid, ${parsed.data.result}, ${parsed.data.reasonCode ?? null}) ON CONFLICT (event_id) DO UPDATE SET result = EXCLUDED.result, reason_code = EXCLUDED.reason_code, acknowledged_at = NOW()`,
      );
      res.json({ accepted: true });
    }),
  );
  return router;
}
