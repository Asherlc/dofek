export type DataReadinessStatus = "healthy" | "syncing" | "stale" | "missing" | "blocked";

export interface DataReadinessBannerSnapshot {
  overallStatus: DataReadinessStatus;
  generatedAt?: string;
  syncingProviders?: Array<{ name: string }>;
}

const headingByStatus: Record<Exclude<DataReadinessStatus, "healthy" | "syncing">, string> = {
  stale: "Dashboard summaries are catching up",
  missing: "No data has synced yet",
  blocked: "Data pipeline needs attention",
};

function syncingHeading(providers: Array<{ name: string }>): string {
  if (providers.length === 0) return "Data is syncing now";
  if (providers.length === 1) return `Syncing ${providers[0]?.name ?? "data source"}`;
  if (providers.length === 2) {
    return `Syncing ${providers[0]?.name ?? "data source"} and ${providers[1]?.name ?? "data source"}`;
  }
  const leading = providers
    .slice(0, -1)
    .map((provider) => provider.name)
    .join(", ");
  const last = providers.at(-1)?.name ?? "data source";
  return `Syncing ${leading}, and ${last}`;
}

export function bannerHeading(data: DataReadinessBannerSnapshot): string {
  switch (data.overallStatus) {
    case "syncing":
      return syncingHeading(data.syncingProviders ?? []);
    case "stale":
    case "missing":
    case "blocked":
      return headingByStatus[data.overallStatus];
    default:
      return "";
  }
}

export function freshnessLabel(data: DataReadinessBannerSnapshot): string {
  if (!data.generatedAt) return "";

  const generatedAt = new Date(data.generatedAt);
  const year = generatedAt.getUTCFullYear();
  const month = String(generatedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(generatedAt.getUTCDate()).padStart(2, "0");
  const hour = String(generatedAt.getUTCHours()).padStart(2, "0");
  const minute = String(generatedAt.getUTCMinutes()).padStart(2, "0");

  return `Last checked ${year}-${month}-${day} ${hour}:${minute} UTC`;
}
