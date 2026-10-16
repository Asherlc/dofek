import type { Area } from "./climbing-log.ts";

export function groupClimbingLogEntriesByArea<
  T extends { climb: { areaPath: readonly Pick<Area, "id" | "name">[] } | null },
>(
  entries: readonly T[],
): Array<{
  area: Pick<Area, "id" | "name"> | null;
  entries: Array<{ entry: T; entryNumber: number }>;
}> {
  const groups = new Map<
    string | null,
    { area: Pick<Area, "id" | "name"> | null; entries: Array<{ entry: T; entryNumber: number }> }
  >();
  entries.forEach((entry, index) => {
    const area = entry.climb?.areaPath.at(-1) ?? null;
    const key = area?.id ?? null;
    let group = groups.get(key);
    if (!group) {
      group = { area, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({ entry, entryNumber: index + 1 });
  });
  return [...groups.values()];
}
