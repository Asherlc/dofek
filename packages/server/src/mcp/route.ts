import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "dofek/db";
import { captureException } from "dofek/lib/error-reporting";
import express, { Router } from "express";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { foodMutationTelemetryFromRequest, logFoodMutation } from "./mutation-telemetry.ts";
import { getMcpResourceUrl } from "./oauth-config.ts";
import {
  mcpClientCorrelationId,
  mcpRequestTelemetry,
  mcpRuntimeTelemetry,
  mcpToolsListResponseTelemetry,
  mcpTransportErrorCategory,
} from "./request-telemetry.ts";
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
    logger.info("mcp.authentication", {
      auth_outcome: "missing_bearer",
      http_status: 401,
      ...mcpRuntimeTelemetry(),
      protocol_version: getSingleHeaderValue(request.headers["mcp-protocol-version"])
        ? "provided"
        : "missing",
    });
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
    const requestTelemetry = mcpRequestTelemetry(
      request.body,
      getSingleHeaderValue(request.headers["mcp-protocol-version"]),
    );
    const runtimeTelemetry = mcpRuntimeTelemetry();
    const startedAt = performance.now();
    let responseFinished = false;
    let responseClosed = false;
    let resourcesClosed = false;
    let transport: StreamableHTTPServerTransport | undefined;
    let server: ReturnType<typeof createDofekMcpServer> | undefined;
    const closeResources = () => {
      if (resourcesClosed || !transport || !server) return;
      resourcesClosed = true;
      transport?.close().catch((error: unknown) => {
        captureException(new Error("MCP transport cleanup failed"));
        logger.warn("mcp.request", {
          ...requestTelemetry,
          cleanup_target: "transport",
          error_category: mcpTransportErrorCategory(error),
          outcome: "cleanup_failed",
        });
      });
      server?.close().catch((error: unknown) => {
        captureException(new Error("MCP server cleanup failed"));
        logger.warn("mcp.request", {
          ...requestTelemetry,
          cleanup_target: "server",
          error_category: mcpTransportErrorCategory(error),
          outcome: "cleanup_failed",
        });
      });
    };
    response.on("finish", () => {
      responseFinished = true;
      logger.info("mcp.request", {
        ...requestTelemetry,
        ...runtimeTelemetry,
        duration_ms: Math.round(performance.now() - startedAt),
        http_status: response.statusCode,
        outcome:
          response.statusCode === 400
            ? "transport_or_protocol_rejected"
            : response.statusCode >= 400
              ? "http_rejected"
              : "completed",
      });
    });
    response.on("close", () => {
      responseClosed = true;
      if (!responseFinished) {
        logger.info("mcp.request", {
          ...requestTelemetry,
          ...runtimeTelemetry,
          duration_ms: Math.round(performance.now() - startedAt),
          http_status: response.statusCode,
          outcome: "aborted",
        });
      }
      closeResources();
    });
    const telemetry = foodMutationTelemetryFromRequest(request.body);
    if (telemetry) {
      logFoodMutation(telemetry, "started");
      let responseFinished = false;
      response.on("finish", () => {
        responseFinished = true;
        logFoodMutation(telemetry, "completed", { httpStatus: response.statusCode });
      });
      response.on("close", () => {
        if (!responseFinished)
          logFoodMutation(telemetry, "aborted", { httpStatus: response.statusCode });
      });
    }
    const token = response.locals.mcpBearerToken;
    if (typeof token !== "string") {
      sendUnauthorized(response);
      return;
    }

    const validatedToken = await validateMcpToken(options.db, token);
    if (!validatedToken) {
      logger.info("mcp.authentication", {
        auth_outcome: "invalid_token",
        http_status: 401,
        ...requestTelemetry,
        ...runtimeTelemetry,
      });
      sendUnauthorized(response);
      return;
    }

    logger.info("mcp.authentication", {
      auth_outcome: "accepted",
      client_kind: validatedToken.oauthClientId ? "oauth" : "personal_token",
      client_id_hash: mcpClientCorrelationId(
        validatedToken.oauthClientId ?? validatedToken.tokenId,
      ),
      scope_set: [...validatedToken.scopes].sort().join(","),
      ...requestTelemetry,
      ...runtimeTelemetry,
    });

    const mcpServer = createDofekMcpServer({
      db: options.db,
      userId: validatedToken.userId,
      clientId: validatedToken.oauthClientId
        ? `oauth:${validatedToken.oauthClientId}`
        : `token:${validatedToken.tokenId}`,
      scopes: validatedToken.scopes,
      timezone: getSingleHeaderValue(request.headers["x-timezone"]) ?? "UTC",
      sensorStore: options.sensorStore,
    });
    server = mcpServer;
    const mcpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    if (requestTelemetry.mcp_method === "tools/list") {
      const send = mcpTransport.send.bind(mcpTransport);
      mcpTransport.send = async (message, sendOptions) => {
        logger.info("mcp.tools_list", {
          ...requestTelemetry,
          ...runtimeTelemetry,
          ...mcpToolsListResponseTelemetry(message),
        });
        return send(message, sendOptions);
      };
    }
    mcpTransport.onerror = (error: Error) => {
      logger.info("mcp.request", {
        ...requestTelemetry,
        ...runtimeTelemetry,
        error_category: mcpTransportErrorCategory(error),
        outcome: "transport_error",
      });
    };
    transport = mcpTransport;
    if (responseClosed) {
      closeResources();
      return;
    }

    try {
      await mcpServer.connect(mcpTransport);
      await mcpTransport.handleRequest(request, response, request.body);
    } catch (error: unknown) {
      const errorCategory = mcpTransportErrorCategory(error);
      captureException(new Error(`MCP request failed: ${errorCategory}`));
      logger.error("mcp.request", {
        ...requestTelemetry,
        ...runtimeTelemetry,
        error_category: errorCategory,
        outcome: "exception",
      });
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

  router.use(
    (
      error: unknown,
      request: express.Request,
      _response: express.Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof SyntaxError) {
        logger.info("mcp.request", {
          ...mcpRequestTelemetry(
            undefined,
            getSingleHeaderValue(request.headers["mcp-protocol-version"]),
          ),
          ...mcpRuntimeTelemetry(),
          http_status: 400,
          outcome: "malformed_json",
        });
      }
      next(error);
    },
  );

  return router;
}
