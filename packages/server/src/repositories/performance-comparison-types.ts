export type PerformanceEquivalence =
  | { kind: "provider_workout_id"; provider: "peloton"; value: string }
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
  | { kind: "activity_name"; canonicalType: string; value: string };
