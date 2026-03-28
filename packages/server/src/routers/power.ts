import type { CriticalPowerModel } from "@dofek/training/power-analysis";
export type { CriticalPowerModel };

import { z } from "zod";
import { PowerRepository } from "../repositories/power-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const powerRouter = router({
	powerCurve: cachedProtectedQuery(CacheTTL.LONG)
		.input(z.object({ days: z.number().default(90) }))
		.query(async ({ ctx, input }) => {
			const repo = new PowerRepository(ctx.db, ctx.userId, ctx.timezone);
			return repo.getPowerCurve(input.days);
		}),
	eftpTrend: cachedProtectedQuery(CacheTTL.LONG)
		.input(z.object({ days: z.number().default(365) }))
		.query(async ({ ctx, input }) => {
			const repo = new PowerRepository(ctx.db, ctx.userId, ctx.timezone);
			return repo.getEftpTrend(input.days);
		}),
});
