import { z } from "zod";

const availabilityFields = z.object({
  sourceLabel: z.string().min(1),
  observedCount: z.number().int().nonnegative(),
  minimumCount: z.number().int().positive(),
  message: z.string().min(1),
});

export const trainingChartAvailabilitySchema = z.discriminatedUnion("status", [
  availabilityFields.extend({ status: z.literal("available") }),
  availabilityFields.extend({ status: z.literal("insufficient_data") }),
]);

export type TrainingChartAvailability = z.infer<typeof trainingChartAvailabilitySchema>;

export function makeTrainingChartAvailability(
  input: Omit<TrainingChartAvailability, "status">,
): TrainingChartAvailability {
  return {
    ...input,
    status: input.observedCount >= input.minimumCount ? "available" : "insufficient_data",
  };
}
