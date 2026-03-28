import { z } from "zod";
import { HealthReportRepository } from "../repositories/health-report-repository.ts";
import {
	CacheTTL,
	cachedProtectedQuery,
	protectedProcedure,
	publicProcedure,
	router,
} from "../trpc.ts";

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
			const repo = new HealthReportRepository(ctx.db, ctx.userId);
			const report = await repo.generate(input.reportType, input.reportData, input.expiresInDays);
			return report?.toDetail() ?? null;
		}),

	/** Get a shared report by token — anyone with the link can view */
	getShared: publicProcedure
		.input(z.object({ token: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const report = await HealthReportRepository.getShared(ctx.db, input.token);
			return report?.toDetail() ?? null;
		}),

	/** List the current user's shared reports */
	myReports: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
		const repo = new HealthReportRepository(ctx.db, ctx.userId);
		return (await repo.myReports()).map((report) => report.toDetail());
	}),
});
