import * as Updates from "expo-updates";

const UNKNOWN_APP_VERSION = "unknown";
const EMBEDDED_ASSETS_VERSION = "embedded";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getManifestAppVersion(): string | null {
  const manifest = Updates.manifest;
  if (!isRecord(manifest)) {
    return null;
  }

  const version = Reflect.get(manifest, "version");
  return typeof version === "string" && version.trim().length > 0 ? version : null;
}

export function getVersionHeaders(): { "x-app-version": string; "x-assets-version": string } {
  const applicationVersion =
    getManifestAppVersion() ?? Updates.runtimeVersion ?? UNKNOWN_APP_VERSION;
  const assetsVersion = Updates.updateId ?? EMBEDDED_ASSETS_VERSION;
  return {
    "x-app-version": applicationVersion,
    "x-assets-version": assetsVersion,
  };
}
