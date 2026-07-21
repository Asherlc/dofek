import { IDENTITY_PROVIDER_NAMES, SetPasswordRequestSchema } from "@dofek/auth/auth";
import { TRPCError } from "@trpc/server";
import { queryCache } from "dofek/lib/cache";
import { z } from "zod";
import { InvalidPasswordError } from "../auth/password.ts";
import {
  getPasswordCredentialStatus,
  InvalidCredentialsError,
  MissingCurrentPasswordError,
  MissingProfileEmailError,
  setPasswordForUser,
} from "../auth/password-credential.ts";
import { AuthRepository } from "../repositories/auth-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const identityProviderNames = new Set<string>(IDENTITY_PROVIDER_NAMES);
const onlyLoginMethodMessage = "Cannot unlink your only login method";

function addUnlinkability(
  accounts: Awaited<ReturnType<AuthRepository["getLinkedAccounts"]>>,
  hasPassword: boolean,
) {
  const loginMethodCount =
    accounts.filter((account) => identityProviderNames.has(account.authProvider)).length +
    Number(hasPassword);

  return accounts.map((account) => {
    const isLoginMethod = identityProviderNames.has(account.authProvider);
    const canUnlink = !isLoginMethod || loginMethodCount > 1;
    return {
      ...account,
      canUnlink,
      unlinkReason: canUnlink ? null : onlyLoginMethodMessage,
    };
  });
}

export const authRouter = router({
  passwordCredentialStatus: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(
    async ({ ctx }) => {
      return getPasswordCredentialStatus(ctx.db, ctx.userId);
    },
  ),

  setPassword: protectedProcedure
    .input(SetPasswordRequestSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await setPasswordForUser(ctx.db, ctx.userId, input);
        await queryCache.invalidateByPrefix(`${ctx.userId}:auth.passwordCredentialStatus`);
        return result;
      } catch (error: unknown) {
        if (
          error instanceof InvalidPasswordError ||
          error instanceof InvalidCredentialsError ||
          error instanceof MissingCurrentPasswordError ||
          error instanceof MissingProfileEmailError
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
        }
        throw error;
      }
    }),

  linkedAccounts: cachedProtectedQuery({ maxAge: CacheTTL.SHORT }).query(async ({ ctx }) => {
    const repo = new AuthRepository(ctx.db, ctx.userId);
    const [accounts, passwordCredential] = await Promise.all([
      repo.getLinkedAccounts(),
      getPasswordCredentialStatus(ctx.db, ctx.userId),
    ]);
    return addUnlinkability(accounts, passwordCredential.hasPassword);
  }),

  unlinkAccount: protectedProcedure
    .input(z.object({ accountId: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new AuthRepository(ctx.db, ctx.userId);
      const [accounts, passwordCredential] = await Promise.all([
        repo.getLinkedAccounts(),
        getPasswordCredentialStatus(ctx.db, ctx.userId),
      ]);
      const account = addUnlinkability(accounts, passwordCredential.hasPassword).find(
        (linkedAccount) => linkedAccount.id === input.accountId,
      );
      if (!account) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      }
      if (!account.canUnlink) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: onlyLoginMethodMessage,
        });
      }

      const deletedId = await repo.deleteAccount(input.accountId);
      if (!deletedId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      }

      await queryCache.invalidateByPrefix(`${ctx.userId}:auth.linkedAccounts`);
      return { ok: true };
    }),
});
