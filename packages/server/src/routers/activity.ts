import { TRPCError } from "@trpc/server";
import { getProvider } from "dofek/providers/registry";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { Activity, type ActivityDetail } from "../models/activity.ts";
import { ActivityRepository, StreamPoint as StreamPointModel } from "../repositories/activity-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync.ts";

export type { ActivityDetail, SourceLink } from "../models/activity.ts";

export interface StreamPoint {
  recordedAt: string;
  heartRate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}

export type { ActivityHrZone } from "@dofek/zones/zones";
export type ActivityHrZones = import("@dofek/zones/zones").ActivityHrZone[];

export const activityRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
        endDate: endDateSchema,
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.list(input);
    }),

  byId: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      const row = await repo.findById(input.id);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }

      await ensureProvidersRegistered();
      return new Activity(row, getProvider).toDetail();
    }),

  stream: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        id: z.string().uuid(),
        maxPoints: z.number().int().min(10).max(10000).default(500),
      }),
    )
    .query(async ({ ctx, input }): Promise<StreamPoint[]> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      const points = await repo.getStream(input.id, input.maxPoints);
      return points.map((point) => point.toDetail());
    }),

  hrZones: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityHrZones> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getHrZones(input.id);
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      await repo.delete(input.id);
      return { success: true };
    }),
});

/** Map a raw stream row to a StreamPoint. Exported for backward compatibility. */
export function mapStreamPoint(row: {
  recorded_at: string;
  heart_rate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}): StreamPoint {
  return new StreamPointModel(row).toDetail();
}

// Re-export mapHrZones for backward compatibility with consumers
export { mapHrZones } from "@dofek/zones/zones";
