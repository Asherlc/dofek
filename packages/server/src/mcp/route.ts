import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import express, { Router } from "express";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { getMcpResourceUrl } from "./oauth-config.ts";
import { validateMcpToken } from "./token-repository.ts";
import { createDofekMcpServer } from "./tools.ts";

export interface CreateMcpRouterOptions {
  db: Pick<Database, "execute" | "select" | "transaction">;
  sensorStore?: ActivitySensorStore;
}

function bearerTokenFromHeader(value: string | undefined): string | null {
  if (!value?.startsWith("Bearer ")) {
    return null;
  }
  const token = value.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function sendUnauthorized(response: express.Response): void {
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(getMcpResourceUrl());
  response.set(
    "WWW-Authenticate",
    `Bearer realm="dofek", resource_metadata="${resourceMetadataUrl}"`,
  );
  response.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "MCP bearer token is required." },
    id: null,
  });
}

function requireBearerTokenHeader(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  const token = bearerTokenFromHeader(request.headers.authorization);
  if (!token) {
    sendUnauthorized(response);
    return;
  }
  response.locals.mcpBearerToken = token;
  next();
}

function getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function createMcpRouter(options: CreateMcpRouterOptions): Router {
  const router = Router();

  router.post("/", requireBearerTokenHeader, express.json(), async (request, response) => {
    const token = response.locals.mcpBearerToken;
    if (typeof token !== "string") {
      sendUnauthorized(response);
      return;
    }

    const validatedToken = await validateMcpToken(options.db, token);
    if (!validatedToken) {
      sendUnauthorized(response);
      return;
    }

    const server = createDofekMcpServer({
      db: options.db,
      userId: validatedToken.userId,
      scopes: validatedToken.scopes,
      timezone: getSingleHeaderValue(request.headers["x-timezone"]) ?? "UTC",
      sensorStore: options.sensorStore,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => {
        transport.close().catch((error: unknown) => {
          captureException(error);
          logger.warn(`[mcp] Failed to close transport: ${error}`);
        });
        server.close().catch((error: unknown) => {
          captureException(error);
          logger.warn(`[mcp] Failed to close server: ${error}`);
        });
      });
    } catch (error: unknown) {
      captureException(error);
      logger.error(`[mcp] Request failed: ${error}`);
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "MCP request failed." },
          id: null,
        });
      }
    }
  });

  router.get("/", (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  router.delete("/", (_request, response) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  return router;
}
