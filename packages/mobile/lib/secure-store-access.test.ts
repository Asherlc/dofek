import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSecureStoreAccessibilityError,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";

describe("secure-store-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects keychain accessibility errors", () => {
    expect(
      isSecureStoreAccessibilityError(
        new Error(
          "Calling the 'getValueWithKeyAsync' function has failed\n→ Caused by: User interaction is not allowed.",
        ),
      ),
    ).toBe(true);
    expect(isSecureStoreAccessibilityError(new Error("Something else failed"))).toBe(false);
  });

  it("throws when SecureStore reads fail due to accessibility", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(
      new Error("User interaction is not allowed"),
    );

    await expect(readSecureStoreItem("test-key")).rejects.toThrow(
      "User interaction is not allowed",
    );
  });

  it("rethrows unexpected SecureStore read failures", async () => {
    const error = new Error("Keychain unavailable");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(error);

    await expect(readSecureStoreItem("test-key")).rejects.toThrow("Keychain unavailable");
  });

  it("writes with AFTER_FIRST_UNLOCK accessibility", async () => {
    await writeSecureStoreItem("test-key", "value");

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("test-key", "value", {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  });
});
