import { createHash } from "node:crypto";
import { ghostSessionsCompareResponseSchema } from "@dofek/training/ghost-sessions";
import { z } from "zod";
import {
  ghostScalarPairProofSchema,
  ghostScalarWindow,
} from "../analytics/ghost-session-pair-preparation.ts";
import { ghostTrackStampSchema } from "../db/ghost-track-evidence.ts";

export const ghostSectionPreparationLimits = {
  sections: 8,
  earlierCandidates: 8,
  passesPerSection: 4,
  geometryVertices: 96,
} as const;

export const preparedGhostTrackStampSchema = ghostTrackStampSchema.extend({
  markerSignature: z.string().nullable(),
});

const comparison = ghostSessionsCompareResponseSchema;
const interval = comparison.shape.anchor;
const coordinate = interval.shape.start.pick({ lat: true, lng: true });
const stableId = z.string().regex(/^[a-f0-9]{64}$/);
const passSchema = z.strictObject({
  passId: stableId,
  activityId: z.uuid(),
  startedAt: z.iso.datetime(),
  comparison,
  scalarProof: ghostScalarPairProofSchema,
});

const section = z.strictObject({
  sectionId: stableId,
  anchor: interval,
  geometry: z
    .tuple([coordinate.array().min(2).max(ghostSectionPreparationLimits.geometryVertices)])
    .optional(),
  historyCoverage: z.literal("partial"),
  passes: passSchema.array().max(ghostSectionPreparationLimits.passesPerSection),
});

const preparedGhostSectionSchema = z.discriminatedUnion("kind", [
  section.extend({ kind: z.literal("unnamed-climb") }),
  section.extend({
    kind: z.enum(["named-road", "named-trail"]),
    name: z.string().min(1).max(256),
    attribution: z.string().min(1).max(256),
  }),
]);

/** Identity shared by a recorded section before and after its passes are ready. */
export function ghostRecordedSectionId(
  activityId: string,
  kind: z.infer<typeof preparedGhostSectionSchema>["kind"],
  startTimestampMs: number,
  endTimestampMs: number,
): string {
  return createHash("sha256")
    .update(JSON.stringify([activityId, kind, startTimestampMs, endTimestampMs]))
    .digest("hex");
}

const maximumDateMilliseconds = 8_640_000_000_000_000;

function hasUsableClock(recorded: z.infer<typeof interval>): boolean {
  return (
    Math.abs(recorded.start.timestampMs) <= maximumDateMilliseconds &&
    Math.abs(recorded.end.timestampMs) <= maximumDateMilliseconds
  );
}

type ScalarWindow = ReturnType<typeof ghostScalarWindow>;

function sameWindow(left: ScalarWindow, right: ScalarWindow) {
  return (
    left.activityId === right.activityId &&
    left.memberActivityId === right.memberActivityId &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt
  );
}

export const preparedGhostSectionsSchema = z
  .strictObject({
    status: z.literal("ready"),
    anchorStamp: preparedGhostTrackStampSchema,
    candidateStamps: preparedGhostTrackStampSchema
      .array()
      .max(ghostSectionPreparationLimits.earlierCandidates),
    bounded: z.boolean(),
    sections: preparedGhostSectionSchema.array().max(ghostSectionPreparationLimits.sections),
  })
  .refine(({ anchorStamp, candidateStamps, sections }) => {
    const sources = new Map(
      [anchorStamp, ...candidateStamps].map((stamp) => [stamp.activityId, stamp]),
    );
    if (
      sources.size !== candidateStamps.length + 1 ||
      new Set(sections.map(({ sectionId }) => sectionId)).size !== sections.length
    )
      return false;
    return sections.every((section) => {
      if (
        !hasUsableClock(section.anchor) ||
        new Set(section.passes.map(({ passId }) => passId)).size !== section.passes.length
      )
        return false;
      const line = section.geometry?.[0];
      const first = line?.[0];
      const last = line?.at(-1);
      if (
        line &&
        (first?.lat !== section.anchor.start.lat ||
          first.lng !== section.anchor.start.lng ||
          last?.lat !== section.anchor.end.lat ||
          last.lng !== section.anchor.end.lng)
      )
        return false;
      return section.passes.every((pass) => {
        const source = sources.get(pass.activityId);
        const { anchor, candidate, metrics } = pass.comparison;
        if (
          !source ||
          source.sport !== anchorStamp.sport ||
          pass.startedAt !== source.startedAt ||
          !hasUsableClock(candidate) ||
          anchor.start.timestampMs < section.anchor.start.timestampMs ||
          anchor.end.timestampMs > section.anchor.end.timestampMs ||
          candidate.end.timestampMs > anchor.start.timestampMs
        )
          return false;
        const needsBothProofs = metrics.heartRateBpm !== null || metrics.powerWatts !== null;
        const [firstProof, candidateProof] = pass.scalarProof;
        if (needsBothProofs && (!firstProof?.count || !candidateProof?.count)) return false;
        if (!firstProof) return true;
        const anchorWindow = ghostScalarWindow(anchorStamp, anchor);
        const candidateWindow = ghostScalarWindow(source, candidate);
        return candidateProof
          ? sameWindow(firstProof, anchorWindow) && sameWindow(candidateProof, candidateWindow)
          : sameWindow(firstProof, anchorWindow) || sameWindow(firstProof, candidateWindow);
      });
    });
  }, "Section passes must refer to their recorded scope and selected sources");

export type PreparedGhostSections = z.infer<typeof preparedGhostSectionsSchema>;
