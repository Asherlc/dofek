import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createMcpToken,
  listMcpConnectedApps,
  listMcpPersonalTokens,
  listMcpTokens,
  mcpScopeSchema,
  mcpTokenMetadataSchema,
  mcpTokenPageSchema,
  revokeMcpToken,
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
  cursor: z.guid().optional(),
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
    .output(mcpTokenPageSchema)
    .query(async ({ ctx, input }) => {
      return listMcpConnectedApps(ctx.db, ctx.userId, input.cursor);
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
