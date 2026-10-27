import { randomUUID } from "node:crypto";
import {
  DeveloperClientInputSchema,
  DeveloperClientUpdateSchema,
} from "@dofek/auth/developer-clients";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { getSessionIdFromRequest } from "../auth/cookies.ts";
import { validateSession } from "../auth/session.ts";
import { logger } from "../logger.ts";
import type { DeveloperClientRepository } from "../repositories/developer-client-repository.ts";
import { sendApiProblem } from "./api-problem.ts";
import { createOpaqueSecret } from "./external-write-api-primitives.ts";

const requestIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);

function requestId(request: express.Request): string {
  const parsed = requestIdSchema.safeParse(request.headers["x-request-id"]);
  return parsed.success ? parsed.data : randomUUID();
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

function currentRequestId(response: express.Response): string {
  return response.locals.developerRequestId;
}

function currentUserId(response: express.Response): string {
  return response.locals.developerUserId;
}

function routeClientId(request: express.Request): string {
  const value = request.params.clientId;
  return typeof value === "string" ? value : "";
}

function handleDeveloperErrors(
  label: string,
  handler: (request: express.Request, response: express.Response) => Promise<void>,
): express.RequestHandler {
  return async (request, response, next) => {
    try {
      await handler(request, response);
    } catch (error) {
      if (response.headersSent) {
        next(error);
        return;
      }
      captureException(error);
      logger.error(
        `[developer-clients] ${label} failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      sendApiProblem(response, currentRequestId(response), 503, "SERVICE_UNAVAILABLE");
    }
  };
}

function mutationRateLimit(): express.RequestHandler {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    handler: (_request, response) => {
      sendApiProblem(response, currentRequestId(response), 429, "RATE_LIMITED");
    },
  });
}

export function createDeveloperClientsRouter(deps: {
  db: Database;
  repository: DeveloperClientRepository;
}): Router {
  const router = Router();
  const registrationRateLimit = mutationRateLimit();
  const rotationRateLimit = mutationRateLimit();

  router.use((request, response, next) => {
    response.locals.developerRequestId = requestId(request);
    response.set("x-request-id", response.locals.developerRequestId);
    next();
  });
  router.post("/", registrationRateLimit);
  router.post("/:clientId/rotate", rotationRateLimit);
  router.use(express.json());
  router.use(async (request, response, next) => {
    try {
      const sessionId = getSessionIdFromRequest(request);
      const session = sessionId ? await validateSession(deps.db, sessionId) : null;
      if (!session) {
        sendApiProblem(response, currentRequestId(response), 401, "UNAUTHORIZED");
        return;
      }
      response.locals.developerUserId = session.userId;
      next();
    } catch (error) {
      captureException(error);
      logger.error(
        `[developer-clients] authentication failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      sendApiProblem(response, currentRequestId(response), 503, "SERVICE_UNAVAILABLE");
    }
  });

  router.get(
    "/",
    handleDeveloperErrors("list", async (_request, response) => {
      response.json(await deps.repository.listOwned(currentUserId(response)));
    }),
  );

  router.post(
    "/",
    handleDeveloperErrors("create", async (request, response) => {
      const input = DeveloperClientInputSchema.safeParse(request.body);
      if (!input.success) {
        sendApiProblem(
          response,
          currentRequestId(response),
          422,
          "VALIDATION_ERROR",
          validationDetails(input.error),
        );
        return;
      }
      const secret = createOpaqueSecret();
      const client = await deps.repository.createOwned(
        currentUserId(response),
        input.data,
        secret.hash,
      );
      response.status(201).json({ client, clientSecret: secret.value });
    }),
  );

  router.get(
    "/:clientId",
    handleDeveloperErrors("detail", async (request, response) => {
      const client = await deps.repository.getOwned(
        currentUserId(response),
        routeClientId(request),
      );
      if (!client) {
        sendApiProblem(response, currentRequestId(response), 404, "NOT_FOUND");
        return;
      }
      response.json(client);
    }),
  );

  router.patch(
    "/:clientId",
    handleDeveloperErrors("update", async (request, response) => {
      const input = DeveloperClientUpdateSchema.safeParse(request.body);
      if (!input.success) {
        sendApiProblem(
          response,
          currentRequestId(response),
          422,
          "VALIDATION_ERROR",
          validationDetails(input.error),
        );
        return;
      }
      const client = await deps.repository.updateOwned(
        currentUserId(response),
        routeClientId(request),
        input.data,
      );
      if (!client) {
        sendApiProblem(response, currentRequestId(response), 404, "NOT_FOUND");
        return;
      }
      response.json(client);
    }),
  );

  router.post(
    "/:clientId/rotate",
    handleDeveloperErrors("rotate", async (request, response) => {
      const secret = createOpaqueSecret();
      const client = await deps.repository.rotateOwned(
        currentUserId(response),
        routeClientId(request),
        secret.hash,
      );
      if (!client) {
        sendApiProblem(response, currentRequestId(response), 404, "NOT_FOUND");
        return;
      }
      response.json({ client, clientSecret: secret.value });
    }),
  );

  router.post(
    "/:clientId/revoke",
    handleDeveloperErrors("revoke", async (request, response) => {
      const revoked = await deps.repository.revokeOwned(
        currentUserId(response),
        routeClientId(request),
      );
      if (!revoked) {
        sendApiProblem(response, currentRequestId(response), 404, "NOT_FOUND");
        return;
      }
      response.json({ revoked: true });
    }),
  );

  return router;
}
