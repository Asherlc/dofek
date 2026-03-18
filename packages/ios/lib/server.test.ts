import { describe, expect, it, vi } from "vitest";

// Mock expo-secure-store so the module loads in Node (it imports react-native)
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(() => Promise.resolve(null)),
  deleteItemAsync: vi.fn(),
}));

import { getTrpcUrl } from "./server";

describe("getTrpcUrl", () => {
  it("appends /api/trpc to the server URL", () => {
    expect(getTrpcUrl("https://dofek.example.com")).toBe(
      "https://dofek.example.com/api/trpc",
    );
  });

  it("does not double-slash when server URL has no trailing slash", () => {
    const result = getTrpcUrl("http://localhost:3000");
    expect(result).toBe("http://localhost:3000/api/trpc");
  });
});
