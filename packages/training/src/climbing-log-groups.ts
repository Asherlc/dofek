import type { Area } from "./climbing-log.ts";

type SourceArea = Pick<Area, "id" | "name" | "providerId">;

export function groupClimbingLogEntriesByArea<
  T extends { climb: { areaPath: readonly SourceArea[] } | null },
>(
  entries: readonly T[],
): Array<{
  area: Pick<Area, "id" | "name"> | null;
  entries: Array<{ entry: T; entryNumber: number }>;
}> {
  const pathsByArea = new Map<string, string>();
  const providersByPath = new Map<string, Set<string>>();
  const ambiguousPaths = new Set<string>();
  for (const entry of entries) {
    const area = entry.climb?.areaPath.at(-1);
    if (!area || pathsByArea.has(area.id)) continue;
    const path = JSON.stringify(
      entry.climb?.areaPath.map(({ name }) => name.trim().replace(/\s+/g, " ").toLowerCase()),
    );
    pathsByArea.set(area.id, path);
    const providers = providersByPath.get(path) ?? new Set<string>();
    if (providers.has(area.providerId)) ambiguousPaths.add(path);
    providers.add(area.providerId);
    providersByPath.set(path, providers);
  }
  const groups = new Map<
    string | null,
    { area: Pick<Area, "id" | "name"> | null; entries: Array<{ entry: T; entryNumber: number }> }
  >();
  entries.forEach((entry, index) => {
    const area = entry.climb?.areaPath.at(-1) ?? null;
    const path = area ? pathsByArea.get(area.id) : undefined;
    const key = area
      ? path !== undefined && !ambiguousPaths.has(path)
        ? `path:${path}`
        : `area:${area.id}`
      : null;
    let group = groups.get(key);
    if (!group) {
      group = { area, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({ entry, entryNumber: index + 1 });
  });
  return [...groups.values()];
}
