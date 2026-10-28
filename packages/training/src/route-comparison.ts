import { z } from "zod";

/** Server-computed attempts belonging to the same GPS-matched route. */
export const routeComparisonInstanceSchema = z.object({
  activityId: z.uuid(),
  activityName: z.string(),
  startedAt: z.iso.datetime(),
  date: z.iso.date(),
  distanceKm: z.number().positive().nullable(),
  durationMinutes: z.number().positive(),
  averagePaceMinPerKm: z.number().positive().nullable(),
  avgHeartRate: z.number().nullable(),
  elevationGainMeters: z.number(),
});

export const routeComparisonSchema = z.object({
  routeId: z.uuid(),
  activityName: z.string(),
  activityType: z.string(),
  attemptCount: z.number().int().min(2),
  instances: z.array(routeComparisonInstanceSchema).min(2),
});

export const routeComparisonsSchema = z.array(routeComparisonSchema);

export type RouteComparisonInstance = z.infer<typeof routeComparisonInstanceSchema>;
export type RouteComparison = z.infer<typeof routeComparisonSchema>;

/** Follow a selected attempt anchor when a new matching attempt changes the route ID. */
export function resolveRouteComparisonSelection(
  routes: readonly RouteComparison[],
  selectedRouteId: string | undefined,
): RouteComparison | undefined {
  return (
    routes.find((route) => route.routeId === selectedRouteId) ??
    routes.find((route) =>
      route.instances.some((attempt) => attempt.activityId === selectedRouteId),
    ) ??
    routes[0]
  );
}
