import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { CacheTTL, cachedProtectedQueryLight, protectedProcedure, router } from "../trpc.ts";

export const authRouter = router({
  linkedAccounts: cachedProtectedQueryLight(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{
      id: string;
      auth_provider: string;
      email: string | null;
      name: string | null;
      created_at: string;
    }>(
      sql`SELECT id, auth_provider, email, name, created_at::text
          FROM fitness.auth_account
          WHERE user_id = ${ctx.userId}
          ORDER BY created_at`,
    );
    return rows.map((row) => ({
      id: row.id,
      authProvider: row.auth_provider,
      email: row.email,
      name: row.name,
      createdAt: row.created_at,
    }));
  }),

  unlinkAccount: protectedProcedure
    .input(z.object({ accountId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Ensure user has at least 2 linked accounts before unlinking
      const countRows = await ctx.db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM fitness.auth_account WHERE user_id = ${ctx.userId}`,
      );
      const countRow = countRows[0];
      if (!countRow || parseInt(countRow.count, 10) < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot unlink your only login method",
        });
      }

      // Only delete if it belongs to the current user
      const deleted = await ctx.db.execute<{ id: string }>(
        sql`DELETE FROM fitness.auth_account
            WHERE id = ${input.accountId} AND user_id = ${ctx.userId}
            RETURNING id`,
      );
      if (deleted.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      }
      return { ok: true };
    }),
});
