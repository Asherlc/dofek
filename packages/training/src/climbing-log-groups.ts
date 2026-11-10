import { type Area, climbingLogEntryAreaPath } from "./climbing-log.ts";

type SourceArea = Pick<Area, "id" | "name" | "providerId">;

export function groupClimbingLogEntriesByArea<
  T extends { climb: { areaPath: readonly SourceArea[] } | null; areaPath?: readonly SourceArea[] },
>(
  entries: readonly T[],
): Array<{
  area: Pick<Area, "id" | "name"> | null;
  areaPath: readonly SourceArea[];
  entries: Array<{ entry: T; entryNumber: number }>;
}> {
  const pathsByArea = new Map<string, string>();
  const providersByPath = new Map<string, Set<string>>();
  const ambiguousPaths = new Set<string>();
  for (const entry of entries) {
    const area = climbingLogEntryAreaPath(entry).at(-1);
    if (!area || pathsByArea.has(area.id)) continue;
    const path = JSON.stringify(
      climbingLogEntryAreaPath(entry).map(({ name }) =>
        name.trim().replace(/\s+/g, " ").toLowerCase(),
      ),
    );
    pathsByArea.set(area.id, path);
    const providers = providersByPath.get(path) ?? new Set<string>();
    if (providers.has(area.providerId)) ambiguousPaths.add(path);
    providers.add(area.providerId);
    providersByPath.set(path, providers);
  }
  const groups = new Map<
    string | null,
    {
      area: Pick<Area, "id" | "name"> | null;
      areaPath: readonly SourceArea[];
      entries: Array<{ entry: T; entryNumber: number }>;
    }
  >();
  entries.forEach((entry, index) => {
    const area = climbingLogEntryAreaPath(entry).at(-1) ?? null;
    const path = area ? pathsByArea.get(area.id) : undefined;
    const key = area
      ? path !== undefined && !ambiguousPaths.has(path)
        ? `path:${path}`
        : `area:${area.id}`
      : null;
    let group = groups.get(key);
    if (!group) {
      group = { area, areaPath: climbingLogEntryAreaPath(entry), entries: [] };
      groups.set(key, group);
    }
    group.entries.push({ entry, entryNumber: index + 1 });
  });
  return [...groups.values()];
}
