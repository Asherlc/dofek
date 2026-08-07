import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createMcpToken,
  listMcpTokens,
  mcpScopeSchema,
  revokeMcpToken,
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
