import { z } from "zod";

export const climbingChartAnnotationSchema = z
  .strictObject({
    id: z.string(),
    label: z.string(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
  })
  .refine(
    (annotation) =>
      annotation.endedAt === null ||
      Date.parse(annotation.endedAt) >= Date.parse(annotation.startedAt),
    {
      message: "A climb must end at or after its start.",
    },
  );

export type ClimbingChartAnnotation = z.infer<typeof climbingChartAnnotationSchema>;

/** Plot geometry only; retain the original timestamps for labels and disclosures. */
export function climbingChartPositions(
  annotations: readonly ClimbingChartAnnotation[],
  startedAt: number,
  endedAt: number,
) {
  return annotations.flatMap((annotation) => {
    const start = Date.parse(annotation.startedAt);
    const end = annotation.endedAt === null ? start : Date.parse(annotation.endedAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      end < startedAt ||
      start > endedAt
    )
      return [];
    const position = (timestamp: number) =>
      endedAt === startedAt
        ? 0.5
        : Math.max(0, Math.min(1, (timestamp - startedAt) / (endedAt - startedAt)));
    return [{ annotation, startPosition: position(start), endPosition: position(end) }];
  });
}
