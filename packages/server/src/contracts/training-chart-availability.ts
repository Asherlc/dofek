import {
  type TrainingChartAvailability,
  trainingChartAvailabilitySchema,
} from "@dofek/training/training-chart-availability";

export type { TrainingChartAvailability };
export { trainingChartAvailabilitySchema };

export function makeTrainingChartAvailability(
  input: Omit<TrainingChartAvailability, "status" | "message"> & {
    messages: {
      available: string;
      insufficientData: string;
    };
  },
): TrainingChartAvailability {
  const status = input.observedCount >= input.minimumCount ? "available" : "insufficient_data";
  const { messages, ...availability } = input;
  return {
    ...availability,
    status,
    message: status === "available" ? messages.available : messages.insufficientData,
  };
}
