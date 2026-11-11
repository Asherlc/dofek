export const MAXIMUM_EXPANSION_ITERATIONS = 32;
export const MAXIMUM_EXPANDED_ACTIVITY_IDS = 10_000;

export interface ActivityIntegrityScopeInput {
  userId: string;
  activityIds: readonly string[];
}
