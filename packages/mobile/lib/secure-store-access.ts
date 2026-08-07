import * as SecureStore from "expo-secure-store";

export const BACKGROUND_ACCESSIBLE_STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
} as const;

export function isSecureStoreAccessibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("User interaction is not allowed") ||
    message.includes("errSecInteractionNotAllowed")
  );
}

export async function readSecureStoreItem(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

export async function writeSecureStoreItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, BACKGROUND_ACCESSIBLE_STORE_OPTIONS);
}

export async function deleteSecureStoreItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (error) {
    if (isSecureStoreAccessibilityError(error)) {
      return;
    }
    throw error;
  }
}
