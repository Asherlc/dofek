import { z } from "zod";
import {
  EFFORT_IDENTITY_KINDS,
  EQUIVALENCE_STRENGTHS,
} from "../repositories/repeated-effort-types.ts";

const identityEvidenceSchema = z.strictObject({
  canonicalActivityId: z.uuid(),
  sourceActivityId: z.uuid().nullable(),
  provider: z.string().nullable(),
  externalId: z.string().nullable(),
  namespace: z.string().nullable(),
  value: z.string(),
  method: z.string(),
  sourceField: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
});

export const repeatedEffortsResultSchema = z.strictObject({
  groups: z.array(
    z.strictObject({
      effortId: z.string(),
      kind: z.enum(EFFORT_IDENTITY_KINDS),
      displayName: z.string().nullable(),
      providers: z.array(z.string()),
      modalities: z.array(z.string()),
      canonicalTypes: z.array(z.string()),
      expectedDurationSeconds: z.number().positive().nullable(),
      repetitionCount: z.number().int().min(2),
      firstOccurrence: z.iso.datetime(),
      lastOccurrence: z.iso.datetime(),
      canonicalActivityIds: z.array(z.uuid()),
      memberActivityIds: z.array(z.uuid()),
      sourceEvidence: z.array(
        z.strictObject({
          canonicalActivityId: z.uuid(),
          sourceActivityId: z.uuid(),
          provider: z.string(),
          externalId: z.string().nullable(),
        }),
      ),
      identityEvidence: z.array(identityEvidenceSchema),
      strength: z.enum(EQUIVALENCE_STRENGTHS),
      assumptions: z.array(z.string()),
      qualityFlags: z.array(z.string()),
    }),
  ),
  nextCursor: z.string().nullable(),
  assumptions: z.array(z.string()),
});

export const repeatedEffortsOutputSchema = z.strictObject({ result: repeatedEffortsResultSchema });
