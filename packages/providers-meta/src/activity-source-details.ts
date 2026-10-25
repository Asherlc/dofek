import type { ActivityOrigin } from "./activity-origin.ts";
import { providerLabel, providerSourceLogo } from "./providers.ts";

export interface ActivitySourceApp {
  provider: string;
  label: string;
}

export interface ActivitySourceDetails {
  recordingApp: ActivitySourceApp;
  importedVia: ActivitySourceApp | null;
}

/** Presentation roles from resolved origin, independent of field priorities. */
export function activitySourceDetails(origin: ActivityOrigin): ActivitySourceDetails | null {
  if (origin.status === "unresolved") return null;
  const source = providerSourceLogo(origin.providerId, origin.sourceName);
  return {
    recordingApp: { provider: source.provider, label: providerLabel(source.provider) },
    importedVia: source.viaAppleHealth
      ? { provider: "apple_health", label: providerLabel("apple_health") }
      : null,
  };
}
