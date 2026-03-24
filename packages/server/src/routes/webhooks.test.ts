import { describe, expect, it, vi } from "vitest";

// Test the webhook router creation without HTTP requests — verify
// that the module exports correctly and the router factory works.

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
    const db = {} as import("dofek/db").Database;
    const mockQueue = { add: vi.fn() };
    const router = createWebhookRouter({
      db,
      getSyncQueue: () => mockQueue as unknown as import("bullmq").Queue,
    });
    // Router should be a function (Express middleware)
    expect(typeof router).toBe("function");
  });
});
