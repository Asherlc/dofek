import { AccountErasureBearerCapabilitySchema } from "@dofek/auth/account-erasure";
import { TRPCError } from "@trpc/server";
import {
  AppleRevocationCredentialMissingError,
  createEncryptedAccountErasureSnapshot,
  ProviderRevocationPrerequisiteError,
} from "dofek/account-erasure/remote-snapshot";
import { eraseStripeForAcceptedAccountErasure } from "dofek/account-erasure/stripe-acceptance";
import {
  AccountErasurePreparationUnavailableError,
  confirmAccountErasure,
  findAccountErasureStatus,
  prepareAccountErasure,
} from "dofek/db/account-erasure";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { getAllProviders } from "dofek/providers/registry";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

const RECENT_AUTHENTICATION_MS = 15 * 60 * 1_000;

export const accountErasureRouter = router({
  prepare: protectedProcedure
    .input(
      z.strictObject({
        confirmation: z.literal("DELETE"),
      }),
    )
    .mutation(async ({ ctx }) => {
      const authenticatedAt = ctx.authenticatedAt;
      if (!authenticatedAt || Date.now() - authenticatedAt.getTime() > RECENT_AUTHENTICATION_MS) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "For your security, sign in again before deleting your account.",
        });
      }

      return prepareAccountErasure(ctx.db, ctx.userId, (identities) =>
        ctx.accountErasureRestoreLedger.listIntentsForIdentities(identities),
      );
    }),

  confirm: publicProcedure
    .input(
      z.strictObject({
        preparationToken: AccountErasureBearerCapabilitySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();
      try {
        const initiation = await confirmAccountErasure(ctx.db, input.preparationToken, {
          createEncryptedRemoteSnapshot: async (transaction, userId) => {
            await invalidateAllUserQueries(userId);
            return createEncryptedAccountErasureSnapshot(transaction, userId, getAllProviders());
          },
          findRestoreIntent: (reference) => ctx.accountErasureRestoreLedger.findIntent(reference),
          persistRestoreIntent: (intent) => ctx.accountErasureRestoreLedger.recordIntent(intent),
        });
        await eraseStripeForAcceptedAccountErasure(ctx.db, initiation.requestId);
        return initiation;
      } catch (error: unknown) {
        if (error instanceof AccountErasurePreparationUnavailableError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error.message,
          });
        }
        if (
          error instanceof AppleRevocationCredentialMissingError ||
          error instanceof ProviderRevocationPrerequisiteError
        ) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: error.message,
          });
        }
        throw error;
      }
    }),

  status: publicProcedure
    .input(
      z.strictObject({
        statusToken: AccountErasureBearerCapabilitySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const status = await findAccountErasureStatus(ctx.db, input.statusToken);
      if (!status) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Account deletion request not found.",
        });
      }
      return status;
    }),
});
