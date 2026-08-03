import { TRPCError } from "@trpc/server";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { z } from "zod";
import {
  companionConnectionTypeSchema,
  DEFAULT_COMPANION_CONNECTION_TYPE,
} from "../companion/connection-type.ts";
import {
  createOrGetCompanionToken,
  listActiveCompanionTokens,
  regenerateCompanionTokenInTransaction,
  revokeCompanionToken,
} from "../companion/token-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const companionTokenOutputSchema = z.object({
  id: z.string(),
  connectionType: companionConnectionTypeSchema,
  token: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export const companionTokenRouter = router({
  retrieve: protectedProcedure
    .input(z.object({ connectionType: companionConnectionTypeSchema }).optional())
    .output(companionTokenOutputSchema)
    .query(async ({ ctx, input }) => {
      return createOrGetCompanionToken(
        ctx.db,
        ctx.userId,
        input?.connectionType ?? DEFAULT_COMPANION_CONNECTION_TYPE,
      );
    }),

  regenerate: protectedProcedure
    .input(z.object({ connectionType: companionConnectionTypeSchema }).optional())
    .output(companionTokenOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withAccountErasureUserWriteFence(ctx.db, ctx.userId, (transaction) =>
          regenerateCompanionTokenInTransaction(
            transaction,
            ctx.userId,
            input?.connectionType ?? DEFAULT_COMPANION_CONNECTION_TYPE,
          ),
        );
      } catch (error: unknown) {
        if (error instanceof AccountErasureUserFencedError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
    }),

  list: protectedProcedure
    .input(z.void())
    .output(z.array(companionTokenOutputSchema.omit({ token: true })))
    .query(async ({ ctx }) => {
      const connections = await listActiveCompanionTokens(ctx.db, ctx.userId);
      return connections.map(({ token: _token, ...connection }) => connection);
    }),

  revoke: protectedProcedure
    .input(z.object({ connectionType: companionConnectionTypeSchema }))
    .output(z.object({ revoked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return {
        revoked: await revokeCompanionToken(ctx.db, ctx.userId, input.connectionType),
      };
    }),
});
