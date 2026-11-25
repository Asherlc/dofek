const labelResultTtlMs = 24 * 60 * 60 * 1_000;

export function readGhostMapLabelsRegion(value: string | undefined): "eu" | "global" | undefined {
  if (value === undefined || value === "disabled") return undefined;
  if (value === "eu" || value === "global") return value;
  throw new Error("GHOST_MAP_LABELS_REGION must be disabled, eu, or global.");
}

export function readGhostRouteLabelsWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): { provider: { region: "eu" | "global"; apiKey: string }; resultTtlMs: number } | undefined {
  const region = readGhostMapLabelsRegion(environment.GHOST_MAP_LABELS_REGION);
  if (!region) return undefined;
  const apiKey = environment.GEOAPIFY_API_KEY?.trim();
  if (!apiKey)
    throw new Error("GEOAPIFY_API_KEY is required when GHOST_MAP_LABELS_REGION is enabled.");
  return { provider: { region, apiKey }, resultTtlMs: labelResultTtlMs };
}
