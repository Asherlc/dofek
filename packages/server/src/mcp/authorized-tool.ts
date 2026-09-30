import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
} from "@modelcontextprotocol/server";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { getMcpResourceUrl } from "./oauth-config.ts";
import { McpAuthError, type McpScope } from "./token-repository.ts";

/** Declare OAuth requirements and turn enforced scope failures into consent challenges. */
export function registerAuthorizedTool<Input extends z.ZodRawShape>(
  server: McpServer,
  scopes: readonly [McpScope, ...McpScope[]],
  name: string,
  config: Omit<Parameters<McpServer["registerTool"]>[1], "inputSchema" | "outputSchema"> & {
    inputSchema: z.ZodObject<Input>;
    outputSchema?: StandardSchemaWithJSON;
  },
  callback: (
    args: z.infer<z.ZodObject<Input>>,
    context: ServerContext,
  ) => CallToolResult | Promise<CallToolResult>,
  reportUnexpectedError: (error: unknown, operation: "mcp_tool") => void = (error) => {
    captureException(error, { tags: { mcp_tool: name } });
  },
) {
  return server.registerTool(
    name,
    {
      ...config,
      _meta: {
        ...config._meta,
        securitySchemes: [{ type: "oauth2", scopes: [...scopes] }],
      },
    },
    async (args, context) => {
      try {
        return await callback(args, context);
      } catch (error: unknown) {
        if (!(error instanceof McpAuthError)) {
          reportUnexpectedError(error, "mcp_tool");
          throw error;
        }
        const resourceMetadata = getOAuthProtectedResourceMetadataUrl(getMcpResourceUrl());
        const challengeResponse = bearerAuthChallengeResponse(
          new OAuthError(error.code, error.message),
          { resourceMetadataUrl: resourceMetadata, requiredScopes: [...scopes] },
        );
        const challenge = z.string().parse(challengeResponse.headers.get("WWW-Authenticate"));
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
          _meta: {
            "mcp/www_authenticate": [challenge],
          },
        };
      }
    },
  );
}
