import { TRPCError } from "@trpc/server";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { z } from "zod";
import {
  createOrGetCompanionToken,
  regenerateCompanionTokenInTransaction,
} from "../companion/token-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const companionTokenOutputSchema = z.object({
  id: z.string(),
  token: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export const companionTokenRouter = router({
  retrieve: protectedProcedure.output(companionTokenOutputSchema).query(async ({ ctx }) => {
    return createOrGetCompanionToken(ctx.db, ctx.userId);
  }),

  regenerate: protectedProcedure.output(companionTokenOutputSchema).mutation(async ({ ctx }) => {
    try {
      return await withAccountErasureUserWriteFence(ctx.db, ctx.userId, (transaction) =>
        regenerateCompanionTokenInTransaction(transaction, ctx.userId),
      );
    } catch (error: unknown) {
      if (error instanceof AccountErasureUserFencedError) {
        throw new TRPCError({ code: "CONFLICT", message: error.message });
      }
      throw error;
    }
  }),
});
