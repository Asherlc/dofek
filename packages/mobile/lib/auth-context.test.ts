import { describe, expect, it } from "vitest";

// expo-secure-store, expo-web-browser, expo-apple-authentication, and react-native
// are mocked globally in test-setup.ts

describe("auth-context", () => {
  it("exports AuthProvider and useAuth", async () => {
    const mod = await import("./auth-context");
    expect(mod.AuthProvider).toBeDefined();
    expect(typeof mod.AuthProvider).toBe("function");
    expect(mod.useAuth).toBeDefined();
    expect(typeof mod.useAuth).toBe("function");
  });
});
