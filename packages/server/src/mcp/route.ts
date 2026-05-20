import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as Sentry from "@sentry/node";
import type { Database } from "dofek/db";
import express, { Router } from "express";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { validateMcpToken } from "./token-repository.ts";
import { createDofekMcpServer } from "./tools.ts";

export interface CreateMcpRouterOptions {
  db: Pick<Database, "execute" | "select">;
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
  response.set("WWW-Authenticate", "Bearer");
  response.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "MCP bearer token is required." },
    id: null,
  });
}

export function createMcpRouter(options: CreateMcpRouterOptions): Router {
  const router = Router();

  router.post("/", express.json(), async (request, response) => {
    const token = bearerTokenFromHeader(request.headers.authorization);
    if (!token) {
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
      timezone: "UTC",
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
          Sentry.captureException(error);
          logger.warn(`[mcp] Failed to close transport: ${error}`);
        });
        server.close().catch((error: unknown) => {
          Sentry.captureException(error);
          logger.warn(`[mcp] Failed to close server: ${error}`);
        });
      });
    } catch (error: unknown) {
      Sentry.captureException(error);
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
