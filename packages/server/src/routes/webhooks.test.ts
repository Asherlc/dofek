import { describe, expect, it, vi } from "vitest";

// Mock all heavy dependencies
vi.mock("dofek/providers/registry", () => ({
  getAllProviders: vi.fn(() => []),
}));

vi.mock("../routers/sync.ts", () => ({
  ensureProvidersRegistered: vi.fn(async () => {}),
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: vi.fn(async () => {}),
}));

describe("createWebhookRouter", () => {
  it("creates a valid Express router", async () => {
    const { createWebhookRouter } = await import("./webhooks.ts");
    // Use vi.fn() to create mock objects instead of type assertions
    const db = vi.fn();
    const mockQueue = { add: vi.fn() };
    const router = createWebhookRouter({
      db: db(),
      getSyncQueue: () => mockQueue,
    });
    // Router should be a function (Express middleware)
    expect(typeof router).toBe("function");
  });
});
