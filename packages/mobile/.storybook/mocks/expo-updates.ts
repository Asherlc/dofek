interface UpdateEventSubscription {
  remove(): void;
}

export const channel = "storybook";
export const createdAt = null;
export const currentlyRunning = {};
export const isEmbeddedLaunch = true;
export const isEmergencyLaunch = false;
export const isEnabled = false;
export const isUsingEmbeddedAssets = true;
export const runtimeVersion = "storybook";
export const updateId = null;

export function addListener(_listener: () => void): UpdateEventSubscription {
  return { remove: () => {} };
}

export async function checkForUpdateAsync() {
  return { isAvailable: false };
}

export async function fetchUpdateAsync() {
  return { isNew: false };
}

export async function reloadAsync(): Promise<void> {}

export default {
  addListener,
  channel,
  checkForUpdateAsync,
  createdAt,
  currentlyRunning,
  fetchUpdateAsync,
  isEmbeddedLaunch,
  isEmergencyLaunch,
  isEnabled,
  isUsingEmbeddedAssets,
  reloadAsync,
  runtimeVersion,
  updateId,
};
