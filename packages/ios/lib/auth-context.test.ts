import { describe, expect, it, vi } from "vitest";

// Mock expo dependencies so the module loads in Node
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(() => Promise.resolve(null)),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
}));

describe("auth-context", () => {
  it("exports AuthProvider and useAuth", async () => {
    const mod = await import("./auth-context");
    expect(mod.AuthProvider).toBeDefined();
    expect(typeof mod.AuthProvider).toBe("function");
    expect(mod.useAuth).toBeDefined();
    expect(typeof mod.useAuth).toBe("function");
  });
});
