import { z } from "zod";
import { ActivityRecordingRepository } from "../repositories/activity-recording-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const saveActivitySchema = z.object({
  activityType: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  sourceName: z.string(),
});

export const activityRecordingRouter = router({
  save: protectedProcedure.input(saveActivitySchema).mutation(async ({ ctx, input }) => {
    const repository = new ActivityRecordingRepository(
      ctx.db,
      ctx.userId,
      ctx.metricStreamPublisher,
    );
    const activityId = await repository.saveActivity(input);
    return { activityId };
  }),
});
