import type { OuraClient } from "./client.js";

export type { OuraClient } from "./client.js";

async function getNativeModule(): Promise<OuraClient> {
  const { requireOptionalNativeModule } = await import("expo");
  const native = requireOptionalNativeModule<OuraClient>("OuraBle");
  if (!native) {
    throw new Error(
      "@dofek/oura-ble/expo needs the OuraBle native module. Rebuild your iOS development or production app with the package installed.",
    );
  }
  return native;
}

/** Creates the client for an iOS app built with Expo modules. */
export function createExpoOuraClient(): OuraClient {
  return {
    async discoverRings() {
      return (await getNativeModule()).discoverRings();
    },
    async pairRing(peripheralId, options) {
      return (await getNativeModule()).pairRing(peripheralId, options);
    },
    async syncRing(ringId) {
      return (await getNativeModule()).syncRing(ringId);
    },
    async readEvents(ringId, options) {
      return (await getNativeModule()).readEvents(ringId, options);
    },
    async forgetRing(ringId) {
      await (await getNativeModule()).forgetRing(ringId);
    },
  };
}
