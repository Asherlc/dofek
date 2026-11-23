import { z } from "zod";

const heaviestSetSchema = z.object({
  reps: z.number().int().positive(),
  weightKg: z.number().positive(),
  setId: z.string().uuid(),
  sourceProviders: z.array(z.string()),
});
const endpointSchema = heaviestSetSchema.extend({
  activityId: z.string().uuid(),
  date: z.string().date(),
});
const exerciseSchema = z.object({
  exerciseId: z.string().uuid(),
  exerciseIds: z.array(z.string().uuid()).optional(),
  exerciseName: z.string(),
  equipment: z.string().nullable(),
  totalLoggedSets: z.number().int().nonnegative(),
  sessions: z.array(
    z.object({
      activityId: z.string().uuid(),
      date: z.string().date(),
      loggedSets: z.number().int().nonnegative(),
      sourceProviders: z.array(z.string()),
      heaviestSets: z.array(heaviestSetSchema),
    }),
  ),
  comparisons: z.array(
    z.object({
      reps: z.number().int().positive(),
      observedDates: z.number().int().positive(),
      first: endpointSchema,
      latest: endpointSchema.nullable(),
    }),
  ),
});
export const loggedSetComparisonSchema = z.object({
  exercises: z.array(exerciseSchema),
  research: z.object({ summary: z.string(), url: z.string().url() }),
});
export type LoggedSetExercise = z.infer<typeof exerciseSchema>;
export type LoggedSetComparison = z.infer<typeof loggedSetComparisonSchema>;
