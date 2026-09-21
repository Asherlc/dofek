import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createMcpToken,
  listMcpConnectedApps,
  listMcpPersonalTokens,
  listMcpTokens,
  mcpConnectedAppPageSchema,
  mcpScopeSchema,
  mcpTokenMetadataSchema,
  revokeMcpConnectedApp,
  revokeMcpToken,
  updateMcpConnectedAppScopes,
  updateMcpTokenScopes,
} from "../mcp/token-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const createTokenInput = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(mcpScopeSchema).min(1),
  expiresAt: z.string().datetime().nullable(),
});

const revokeTokenInput = z.object({
  tokenId: z.guid(),
});

const updateScopesInput = z.object({
  tokenId: z.guid(),
  scopes: z.array(mcpScopeSchema).min(1),
});

const listConnectedAppsInput = z.object({
  cursor: z.string().optional(),
});

const revokeConnectedAppInput = z.object({
  oauthClientId: z.string().min(1),
  oauthResource: z.url(),
});

const updateConnectedAppScopesInput = revokeConnectedAppInput.extend({
  scopes: z.array(mcpScopeSchema).min(1),
});

export const mcpRouter = router({
  createToken: protectedProcedure.input(createTokenInput).mutation(async ({ ctx, input }) => {
    return createMcpToken(ctx.db, {
      userId: ctx.userId,
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    });
  }),

  listTokens: protectedProcedure.query(async ({ ctx }) => {
    return listMcpTokens(ctx.db, ctx.userId);
  }),

  listPersonalTokens: protectedProcedure
    .output(z.array(mcpTokenMetadataSchema))
    .query(async ({ ctx }) => {
      return listMcpPersonalTokens(ctx.db, ctx.userId);
    }),

  listConnectedApps: protectedProcedure
    .input(listConnectedAppsInput)
    .output(mcpConnectedAppPageSchema)
    .query(async ({ ctx, input }) => {
      return listMcpConnectedApps(ctx.db, ctx.userId, input.cursor);
    }),

  revokeConnectedApp: protectedProcedure
    .input(revokeConnectedAppInput)
    .mutation(async ({ ctx, input }) => {
      const revoked = await revokeMcpConnectedApp(
        ctx.db,
        ctx.userId,
        input.oauthClientId,
        input.oauthResource,
      );
      if (!revoked) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Connected app not found.",
        });
      }
      return { success: true };
    }),

  updateConnectedAppScopes: protectedProcedure
    .input(updateConnectedAppScopesInput)
    .mutation(async ({ ctx, input }) => {
      const updated = await updateMcpConnectedAppScopes(
        ctx.db,
        ctx.userId,
        input.oauthClientId,
        input.oauthResource,
        input.scopes,
      );
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Connected app not found.",
        });
      }
      return { success: true };
    }),

  updateScopes: protectedProcedure
    .input(updateScopesInput)
    .output(mcpTokenMetadataSchema)
    .mutation(async ({ ctx, input }) => {
      const updatedToken = await updateMcpTokenScopes(
        ctx.db,
        ctx.userId,
        input.tokenId,
        input.scopes,
      );
      if (!updatedToken) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP token not found.",
        });
      }
      return updatedToken;
    }),

  revokeToken: protectedProcedure.input(revokeTokenInput).mutation(async ({ ctx, input }) => {
    const revokedToken = await revokeMcpToken(ctx.db, ctx.userId, input.tokenId);
    if (!revokedToken) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "MCP token not found.",
      });
    }
    return revokedToken;
  }),
});
