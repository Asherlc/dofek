import { TRPCError } from "@trpc/server";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { datedCalendarActivityEntrySchema } from "../contracts/calendar-activity-entry.ts";
import { ActivitiesCalendarRepository } from "../repositories/activities-calendar-repository.ts";
import {
  ActivityLocationSearchRepository,
  activityLocationCursorSchema,
} from "../repositories/activity-location-search-repository.ts";
import {
  activitySearchCursor,
  activitySearchCursorSchema,
  pageActivitySearch,
} from "../repositories/activity-search-pagination.ts";
import {
  activityPlaceCoordinatesSchema,
  activityPlaceSchema,
  searchActivityPlaces,
} from "../services/activity-place-search.ts";
import { protectedProcedure, router } from "../trpc.ts";

const placeNameSchema = z.string().trim().min(1).max(200);

export const activityLocationRouter = router({
  places: protectedProcedure
    .input(z.object({ query: placeNameSchema }))
    .output(z.array(activityPlaceSchema))
    .query(async ({ input }) => {
      const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
      if (!apiKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Place lookup requires GEOAPIFY_API_KEY. Contact support.",
        });
      }
      try {
        return await searchActivityPlaces(input.query, apiKey);
      } catch (error) {
        captureException(error, { tags: { trpcPath: "activityLocation.places" } });
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Place lookup is temporarily unavailable. Try again in a minute.",
        });
      }
    }),

  search: protectedProcedure
    .input(
      z.object({
        location: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("name"), name: placeNameSchema }),
          activityPlaceCoordinatesSchema.extend({ kind: z.literal("nearby") }),
        ]),
        activityType: z.string().min(1).optional(),
        cursor: activitySearchCursorSchema.nullish(),
        pageSize: z.number().int().min(1).max(50).default(20),
      }),
    )
    .output(
      z.object({
        activities: z.array(datedCalendarActivityEntrySchema),
        next: activitySearchCursorSchema.nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repository = new ActivityLocationSearchRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      );
      const calendar = new ActivitiesCalendarRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.sensorStore,
        ctx.accessWindow,
      );
      const codec = activitySearchCursor(activityLocationCursorSchema, [
        ctx.userId,
        input.location,
        ctx.timezone,
        ctx.accessWindow,
        input.activityType,
      ]);
      return pageActivitySearch({
        initialPosition: input.cursor ? await codec.decode(input.cursor) : undefined,
        pageSize: input.pageSize,
        encode: codec.encode,
        hydrate: (ids) => calendar.findByIds(ids, input.activityType),
        load: async (after, limit) =>
          (
            await repository.findCandidates({
              location: input.location,
              activityType: input.activityType,
              after,
              limit,
            })
          ).map((position) => ({ id: position.id, position })),
      });
    }),
});
