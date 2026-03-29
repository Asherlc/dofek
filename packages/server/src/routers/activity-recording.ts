import { z } from "zod";
import { ActivityRecordingRepository } from "../repositories/activity-recording-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const gpsSampleSchema = z.object({
  recordedAt: z.string(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  gpsAccuracy: z.number().nullable(),
  altitude: z.number().nullable(),
  speed: z.number().nullable(),
});

const saveActivitySchema = z.object({
  activityType: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  sourceName: z.string(),
  samples: z.array(gpsSampleSchema),
});

export const activityRecordingRouter = router({
  save: protectedProcedure.input(saveActivitySchema).mutation(async ({ ctx, input }) => {
    const repository = new ActivityRecordingRepository(ctx.db, ctx.userId);
    const activityId = await repository.saveActivity(input);
    return { activityId };
  }),
});
