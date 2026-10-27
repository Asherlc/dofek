import { FREE_ROCK_GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import { attemptScopeSchema, ropeMethodSchema } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { WeakEffortSpecification } from "./repeated-effort-types.ts";
export interface ResolvedEquivalence {
  key: PerformanceEquivalence;
  basis: "derived_from_reference" | "explicit";
  method: string;
  confidence: "high" | "user_asserted";
  assumptions: string[];
}

export const identityEquivalenceSchema = z.union([
  z.strictObject({
    kind: z.enum(["provider_workout", "provider_route", "provider_workout_id"]),
    provider: z.string().trim().min(1),
    value: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.enum(["segment", "climb", "standardized_test"]),
    namespace: z.string().trim().min(1),
    value: z.string().trim().min(1),
  }),
  z.strictObject({ kind: z.literal("canonical_route"), value: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal("user_defined_benchmark"), value: z.uuid() }),
]);
export type IdentityEquivalence = z.infer<typeof identityEquivalenceSchema>;

export const climbingPerformanceIdentitySchema = z.object({
  climbKind: z.enum(["boulder", "route"]),
  gradeSystem: z.enum(FREE_ROCK_GRADE_SYSTEMS),
  grade: z.string(),
  climbName: z.string(),
  locationName: z.string(),
  attemptScope: attemptScopeSchema,
  pitchNumber: z.number().int().positive().nullable(),
  ropeMethod: ropeMethodSchema.nullable(),
  solo: z.boolean().nullable(),
});
export type ClimbingPerformanceIdentity = z.infer<typeof climbingPerformanceIdentitySchema>;

export type PerformanceEquivalence =
  | IdentityEquivalence
  | {
      kind: "cycling_route";
      provider: string;
      activityName: string;
      providerType: string;
    }
  | {
      kind: "standardized_test";
      provider: string;
      activityName: string;
      providerType: string;
    }
  | ({ kind: "climb" } & ClimbingPerformanceIdentity)
  | { kind: "strength_exercise_id"; exerciseId: string }
  | {
      kind: "activity_name";
      canonicalType: string;
      value: string;
      asserted?: boolean;
      weakSpecification?: WeakEffortSpecification;
    };

export function isIdentityEquivalence(key: PerformanceEquivalence): key is IdentityEquivalence {
  return key.kind !== "activity_name" && key.kind !== "strength_exercise_id" && "value" in key;
}
