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
  | {
      kind: "climb";
      climbType: string;
      gradeSystem: string;
      grade: string;
      routeName: string;
      locationName: string;
      lead: boolean | null;
    }
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
