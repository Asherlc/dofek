import { describe, expect, it, vi } from "vitest";

describe("SERVER_URL", () => {
  it("defaults to production server when env var is not set", async () => {
    vi.stubEnv("EXPO_PUBLIC_SERVER_URL", "");
    vi.resetModules();
    const { SERVER_URL } = await import("./server");
    expect(SERVER_URL).toBe("https://dofek.asherlc.com");
  });

  it("uses EXPO_PUBLIC_SERVER_URL when set", async () => {
    vi.stubEnv("EXPO_PUBLIC_SERVER_URL", "https://custom.example.com");
    vi.resetModules();
    const { SERVER_URL } = await import("./server");
    expect(SERVER_URL).toBe("https://custom.example.com");
  });

  it("strips trailing slashes from the env var", async () => {
    vi.stubEnv("EXPO_PUBLIC_SERVER_URL", "https://custom.example.com///");
    vi.resetModules();
    const { SERVER_URL } = await import("./server");
    expect(SERVER_URL).toBe("https://custom.example.com");
  });
});

describe("getTrpcUrl", () => {
  it("appends /api/trpc to the server URL", async () => {
    const { getTrpcUrl } = await import("./server");
    expect(getTrpcUrl("https://dofek.example.com")).toBe(
      "https://dofek.example.com/api/trpc",
    );
  });

  it("does not double-slash when server URL has no trailing slash", async () => {
    const { getTrpcUrl } = await import("./server");
    const result = getTrpcUrl("http://localhost:3000");
    expect(result).toBe("http://localhost:3000/api/trpc");
  });
});
