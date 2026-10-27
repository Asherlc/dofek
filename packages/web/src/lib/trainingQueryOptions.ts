/** Training tab query cache presets — shorter stale times than app defaults for tab switching. */
export const TRAINING_QUERY_GC_TIME_MS = 1_800_000; // 30 min

export const TRAINING_OVERVIEW_QUERY_OPTIONS = {
  staleTime: 120_000,
  gcTime: TRAINING_QUERY_GC_TIME_MS,
} as const;

export const TRAINING_SLOW_QUERY_OPTIONS = {
  staleTime: 300_000,
  gcTime: TRAINING_QUERY_GC_TIME_MS,
} as const;
