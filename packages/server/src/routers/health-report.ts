import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

/** Generate a URL-safe share token */
function generateShareToken(): string {
  return randomBytes(24).toString("base64url");
}

const sharedReportRowSchema = z.object({
  id: z.string(),
  share_token: z.string(),
  report_type: z.string(),
  report_data: z.unknown(),
  expires_at: timestampStringSchema.nullable(),
  created_at: timestampStringSchema,
});

const reportListRowSchema = z.object({
  id: z.string(),
  share_token: z.string(),
  report_type: z.string(),
  expires_at: timestampStringSchema.nullable(),
  created_at: timestampStringSchema,
});

export const healthReportRouter = router({
  /** Generate a shareable health report */
  generate: protectedProcedure
    .input(
      z.object({
        reportType: z.enum(["weekly", "monthly", "healthspan"]),
        reportData: z.record(z.unknown()),
        expiresInDays: z.number().min(1).max(90).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const token = generateShareToken();
      const expiresAt =
        input.expiresInDays != null
          ? sql`NOW() + (${input.expiresInDays}::int || ' days')::interval`
          : sql`NULL`;

      const rows = await executeWithSchema(
        ctx.db,
        sharedReportRowSchema,
        sql`INSERT INTO fitness.shared_report (user_id, share_token, report_type, report_data, expires_at)
            VALUES (${ctx.userId}, ${token}, ${input.reportType}, ${JSON.stringify(input.reportData)}::jsonb, ${expiresAt})
            RETURNING id, share_token, report_type, report_data, expires_at, created_at`,
      );

      const row = rows[0];
      if (!row) return null;

      return {
        id: row.id,
        shareToken: row.share_token,
        reportType: row.report_type,
        reportData: row.report_data,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      };
    }),

  /** Get a shared report by token — anyone with the link can view */
  getShared: protectedProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        sharedReportRowSchema,
        sql`SELECT id, share_token, report_type, report_data, expires_at, created_at
            FROM fitness.shared_report
            WHERE share_token = ${input.token}
              AND (expires_at IS NULL OR expires_at > NOW())`,
      );

      const row = rows[0];
      if (!row) return null;

      return {
        id: row.id,
        shareToken: row.share_token,
        reportType: row.report_type,
        reportData: row.report_data,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      };
    }),

  /** List the current user's shared reports */
  myReports: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      reportListRowSchema,
      sql`SELECT id, share_token, report_type, expires_at, created_at
          FROM fitness.shared_report
          WHERE user_id = ${ctx.userId}
          ORDER BY created_at DESC
          LIMIT 50`,
    );

    return rows.map((row) => ({
      id: row.id,
      shareToken: row.share_token,
      reportType: row.report_type,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }),
});
