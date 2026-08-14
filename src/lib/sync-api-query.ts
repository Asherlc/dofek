export type SyncApiQuery = {
  path: string;
  filters: Record<string, string | number | boolean | null>;
};

/** Stable key for comparing provider API requests across queued request jobs. */
export function syncApiQueryKey(query: SyncApiQuery): string {
  const sortedEntries = Object.keys(query.filters)
    .sort()
    .map((key) => [key, query.filters[key]] as const);
  return `${query.path}?${JSON.stringify(Object.fromEntries(sortedEntries))}`;
}
