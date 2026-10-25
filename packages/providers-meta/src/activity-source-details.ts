import type { ActivityOrigin } from "./activity-origin.ts";
import { appleDeviceModel, deviceDisplayName } from "./device-names.ts";
import { garminDeviceThumbnail } from "./garmin-devices.ts";
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
  const provider = origin.providerId === "apple-health" ? "apple_health" : origin.providerId;
  const name = origin.sourceName?.trim();
  const displayName = name ? deviceDisplayName(name) : name;
  const distinctSource =
    name &&
    ![provider, providerLabel(provider)].some(
      (label) => label.toLowerCase() === name.toLowerCase(),
    );
  const source = distinctSource
    ? provider === "garmin" || garminDeviceThumbnail(displayName) !== null
      ? "garmin"
      : name.startsWith("Watch") && appleDeviceModel(name)
        ? "apple-watch"
        : providerSourceLogo("apple_health", name).provider
    : provider;
  return {
    recordingApp: {
      provider: source,
      label:
        (source === "apple-watch" || source === "garmin") && distinctSource
          ? (displayName ?? providerLabel(source))
          : deviceDisplayName(providerLabel(source)),
    },
    importedVia: source !== provider ? { provider, label: providerLabel(provider) } : null,
  };
}
