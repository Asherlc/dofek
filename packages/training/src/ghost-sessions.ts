import { z } from "zod";

const activityId = z.uuid();
const opaqueId = z.string().min(1).max(256);
const pageCursor = z.string().min(1).max(2_048);
const historyCoverage = z.enum(["complete", "partial"]);
const elapsedToleranceMs = 0.001;

function elapsedAgrees(reportedMs: number, measuredMs: number): boolean {
  return Math.abs(reportedMs - measuredMs) <= elapsedToleranceMs;
}

export const ghostSessionsGetInputSchema = z.strictObject({ activityId });
export const ghostSessionsPassesInputSchema = z.strictObject({
  activityId,
  sectionId: opaqueId,
  cursor: pageCursor.optional(),
});
export const ghostSessionsCompareInputSchema = z.strictObject({
  activityId,
  sectionId: opaqueId,
  passId: opaqueId,
});

const coordinates = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
};
const positionSchema = z.strictObject({
  ...coordinates,
  timestampMs: z.number(),
  distanceMeters: z.number().nonnegative(),
});
type RecordedPosition = z.infer<typeof positionSchema>;

const intervalSchema = z
  .strictObject({
    start: positionSchema,
    end: positionSchema,
    elapsedMs: z.number().positive(),
  })
  .refine(
    ({ start, end }) =>
      start.timestampMs < end.timestampMs && start.distanceMeters <= end.distanceMeters,
    "Interval boundaries must follow recorded progress",
  )
  .refine(
    ({ start, end, elapsedMs }) => elapsedAgrees(elapsedMs, end.timestampMs - start.timestampMs),
    { path: ["elapsedMs"], message: "Elapsed time must agree with the recorded boundaries" },
  );

const suggestionSchema = z.strictObject({
  passId: opaqueId,
  reason: z.enum(["previous-best", "most-recent"]),
});

const sectionSchema = z.strictObject({
  sectionId: opaqueId,
  anchor: intervalSchema.nullable(),
  firstVisit: z.boolean().optional(),
  suggestedGhost: suggestionSchema.nullable(),
  geometry: z
    .array(z.array(z.strictObject(coordinates)).min(2).max(96))
    .min(1)
    .max(8)
    .optional(),
});
const sectionResponseSchema = z.discriminatedUnion("kind", [
  sectionSchema.extend({ kind: z.enum(["route", "shared-stretch", "unnamed-climb"]) }),
  sectionSchema.extend({
    kind: z.enum(["named-road", "named-trail"]),
    name: z.string().min(1).max(256),
    attribution: z.string().min(1).max(256).optional(),
  }),
]);

export const ghostSessionsGetResponseSchema = z
  .strictObject({
    availability: z.enum(["unavailable", "processing", "ready"]),
    sport: z.enum(["running", "cycling"]).nullable(),
    gpsCoverage: z.enum(["complete", "partial", "unusable"]).nullable(),
    historyCoverage,
    nameStatus: z.enum(["disabled", "processing", "ready", "unavailable", "error"]),
    sections: z.array(sectionResponseSchema).max(64),
  })
  .refine(
    ({ availability, historyCoverage, gpsCoverage, sections }) => {
      const usableGps = gpsCoverage === "complete" || gpsCoverage === "partial";
      const canClaimHistory =
        availability === "ready" && historyCoverage === "complete" && usableGps;
      return sections.every(({ anchor, firstVisit, suggestedGhost }) => {
        if (firstVisit) return canClaimHistory && anchor !== null && !suggestedGhost;
        if (suggestedGhost?.reason === "previous-best") return canClaimHistory && anchor !== null;
        return true;
      });
    },
    { path: ["sections"], message: "First-visit or previous-best evidence is incomplete" },
  );

export const ghostSessionsPassesResponseSchema = z.strictObject({
  passes: z
    .array(
      z.strictObject({
        passId: opaqueId,
        activityId,
        startedAt: z.iso.datetime(),
        elapsedMs: z.number().positive(),
      }),
    )
    .max(100),
  nextCursor: pageCursor.nullable(),
});

const positiveMeasurementPair = z.strictObject({
  anchor: z.number().positive(),
  candidate: z.number().positive(),
});

function samePosition(left: RecordedPosition, right: RecordedPosition): boolean {
  return (
    left.timestampMs === right.timestampMs &&
    left.distanceMeters === right.distanceMeters &&
    left.lat === right.lat &&
    left.lng === right.lng
  );
}

function followsProgress(previous: RecordedPosition, current: RecordedPosition): boolean {
  return (
    current.timestampMs >= previous.timestampMs && current.distanceMeters >= previous.distanceMeters
  );
}

export const ghostSessionsCompareResponseSchema = z
  .strictObject({
    anchor: intervalSchema,
    candidate: intervalSchema,
    /** Server-measured anchor elapsed minus candidate elapsed. */
    elapsedDifferenceMs: z.number(),
    timeBasis: z.literal("elapsed-including-recorded-stops"),
    replay: z
      .array(z.strictObject({ anchor: positionSchema, candidate: positionSchema }))
      .min(2)
      .max(96)
      .nullable(),
    replayDownsampled: z.boolean(),
    metrics: z.strictObject({
      paceSecondsPerKm: positiveMeasurementPair.nullable(),
      heartRateBpm: positiveMeasurementPair.nullable(),
      powerWatts: z
        .strictObject({ anchor: z.number().nonnegative(), candidate: z.number().nonnegative() })
        .nullable(),
    }),
  })
  .refine(
    ({ anchor, candidate, elapsedDifferenceMs }) =>
      elapsedAgrees(elapsedDifferenceMs, anchor.elapsedMs - candidate.elapsedMs),
    {
      path: ["elapsedDifferenceMs"],
      message: "Difference must equal anchor elapsed minus candidate elapsed",
    },
  )
  .refine(
    ({ anchor, candidate, replay, replayDownsampled }) => {
      if (replay === null) return !replayDownsampled;
      const first = replay[0];
      const last = replay.at(-1);
      return (
        first !== undefined &&
        last !== undefined &&
        samePosition(first.anchor, anchor.start) &&
        samePosition(first.candidate, candidate.start) &&
        samePosition(last.anchor, anchor.end) &&
        samePosition(last.candidate, candidate.end) &&
        replay.every((key, index) => {
          const prior = replay[index - 1];
          return (
            prior === undefined ||
            (followsProgress(prior.anchor, key.anchor) &&
              followsProgress(prior.candidate, key.candidate))
          );
        })
      );
    },
    { path: ["replay"], message: "Replay must follow progress between both recorded boundaries" },
  );

export type GhostSessionsGetResponse = z.infer<typeof ghostSessionsGetResponseSchema>;
export type GhostSessionsPassesResponse = z.infer<typeof ghostSessionsPassesResponseSchema>;
export type GhostSessionsCompareResponse = z.infer<typeof ghostSessionsCompareResponseSchema>;

interface AnchorBoundaries {
  startTimestampMs: number;
  endTimestampMs: number;
}

interface PriorPass {
  passId: string;
  activityId: string;
  passStartedAtMs: number;
  anchor: AnchorBoundaries;
  elapsedMs: number;
}

function precedes(left: PriorPass, right: PriorPass): boolean {
  if (left.passStartedAtMs !== right.passStartedAtMs)
    return left.passStartedAtMs > right.passStartedAtMs;
  if (left.activityId !== right.activityId) return left.activityId < right.activityId;
  return left.passId < right.passId;
}

/** Supply only prior comparable passes already filtered for owner, visibility, and current evidence. */
export function selectGhostSessionDefault(input: {
  anchor: AnchorBoundaries & { elapsedMs: number };
  passes: readonly PriorPass[];
  historyCoverage: z.infer<typeof historyCoverage>;
}): { firstVisit: boolean; suggestedGhost: z.infer<typeof suggestionSchema> | null } {
  let latest: PriorPass | undefined;
  let best: PriorPass | undefined;
  for (const pass of input.passes) {
    if (!latest || precedes(pass, latest)) latest = pass;
    if (
      pass.anchor.startTimestampMs === input.anchor.startTimestampMs &&
      pass.anchor.endTimestampMs === input.anchor.endTimestampMs &&
      (!best ||
        pass.elapsedMs < best.elapsedMs ||
        (pass.elapsedMs === best.elapsedMs && precedes(pass, best)))
    )
      best = pass;
  }

  if (input.historyCoverage === "complete" && best && input.anchor.elapsedMs < best.elapsedMs)
    return { firstVisit: false, suggestedGhost: { passId: best.passId, reason: "previous-best" } };
  if (latest)
    return { firstVisit: false, suggestedGhost: { passId: latest.passId, reason: "most-recent" } };
  return { firstVisit: input.historyCoverage === "complete", suggestedGhost: null };
}
