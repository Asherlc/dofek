import { describe, expect, it, vi } from "vitest";
import { ensureInstallId } from "./install-id.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

describe("ensureInstallId", () => {
  it("reuses the durable install ID", () => {
    const storage = {
      getItem: vi.fn(() => " install-1 "),
      setItem: vi.fn(),
    };

    expect(ensureInstallId(storage, 123, () => 0.5)).toBe("install-1");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("creates and persists an ID when none exists", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };

    expect(ensureInstallId(storage, 123, () => 0.5)).toBe("123-i");
    expect(storage.setItem).toHaveBeenCalledWith(STORAGE_KEYS.TELEMETRY_INSTALL_ID, "123-i");
  });
});
