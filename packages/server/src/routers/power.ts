import type { CriticalPowerModel } from "@dofek/cycling-power/critical-power";

export type { CriticalPowerModel };

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import { CyclingFtpSuggestionsRepository } from "../repositories/cycling-ftp-suggestions-repository.ts";
import { PowerRepository } from "../repositories/power-repository.ts";
import { CacheTTL, protectedProcedure, router } from "../trpc.ts";

const ftpSuggestionInput = z
  .object({
    start_date: z.iso.date(),
    end_date: z.iso.date(),
  })
  .strict()
  .refine(({ start_date, end_date }) => start_date <= end_date, {
    message: "end_date must be on or after start_date",
    path: ["end_date"],
  });

export const powerRouter = router({
  powerCurve: selectedChartRangeQuery("power.powerCurve", CacheTTL.LONG, async ({ ctx, range }) => {
    if (!ctx.sensorStore) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
      });
    }
    const repo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore, ctx.db);
    return repo.getPowerCurve(range);
  }),
  ftpSuggestions: protectedProcedure.input(ftpSuggestionInput).query(async ({ ctx, input }) => {
    if (!ctx.sensorStore) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "ClickHouse activity analytics store is required for FTP suggestions. Set CLICKHOUSE_URL and retry.",
      });
    }
    const repository = new CyclingFtpSuggestionsRepository(
      ctx.sensorStore,
      ctx.userId,
      ctx.timezone,
      ctx.accessWindow,
    );
    return repository.getSuggestions(input.start_date, input.end_date);
  }),
});
