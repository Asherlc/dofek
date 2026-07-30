import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { HealthReportRepository } from "../repositories/health-report-repository.ts";
import { MonthlyReportRepository } from "../repositories/monthly-report-repository.ts";
import { WeeklyReportRepository } from "../repositories/weekly-report-repository.ts";
import { protectedProcedure, publicProcedure, router } from "../trpc.ts";

const expiresInDaysSchema = z.number().int().min(1).max(90).nullable().default(null);

const generateHealthReportInputSchema = z.discriminatedUnion("reportType", [
  z
    .object({
      reportType: z.literal("weekly"),
      weeks: z.number().int().min(1).max(52).default(12),
      endDate: endDateSchema,
      expiresInDays: expiresInDaysSchema,
    })
    .strict(),
  z
    .object({
      reportType: z.literal("monthly"),
      months: z.number().int().min(1).max(24).default(6),
      endDate: endDateSchema,
      expiresInDays: expiresInDaysSchema,
    })
    .strict(),
]);

const sharedReportOutputSchema = z.object({
  id: z.string(),
  shareToken: z.string(),
  reportType: z.string(),
  reportData: z.unknown(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
const reportListOutputSchema = sharedReportOutputSchema.omit({ reportData: true });

export type HealthReportGenerateInput = z.input<typeof generateHealthReportInputSchema>;

export const healthReportRouter = router({
  /** Generate a shareable health report */
  generate: protectedProcedure
    .input(generateHealthReportInputSchema)
    .output(sharedReportOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const reportData =
        input.reportType === "weekly"
          ? await new WeeklyReportRepository(ctx.userId, ctx.sensorStore).getReport(
              input.weeks,
              input.endDate,
            )
          : await new MonthlyReportRepository(ctx.userId, ctx.sensorStore).getReport(
              input.months,
              input.endDate,
            );

      if (!reportData.current) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `No ${input.reportType} report data is available to share.`,
        });
      }

      const repo = new HealthReportRepository(ctx.db, ctx.userId);
      const report = await repo.generate(input.reportType, reportData, input.expiresInDays);
      if (!report) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The report snapshot could not be created. Please try again.",
        });
      }
      return report.toDetail();
    }),

  /** Get a shared report by token — anyone with the link can view */
  getShared: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .output(sharedReportOutputSchema.nullable())
    .query(async ({ ctx, input }) => {
      const report = await HealthReportRepository.getShared(ctx.db, input.token);
      return report?.toDetail() ?? null;
    }),

  /** List the current user's shared reports */
  myReports: protectedProcedure.output(z.array(reportListOutputSchema)).query(async ({ ctx }) => {
    const repo = new HealthReportRepository(ctx.db, ctx.userId);
    return (await repo.myReports()).map((report) => report.toDetail());
  }),
});
