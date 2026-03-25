import { describe, expect, it, vi } from "vitest";

// Mock the typed-sql module
vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(),
  dateStringSchema: {
    parse: (v: unknown) => v,
  },
}));

// Mock trpc module
vi.mock("../trpc.ts", async () => {
  const { z } = await import("zod");

  const mockCtx = {
    db: { execute: vi.fn() },
    userId: "00000000-0000-0000-0000-000000000001",
  };

  // Simple test helper that creates procedures matching the tRPC API shape
  function makeProcedure() {
    return {
      input: (schema: z.ZodType) => ({
        query: (fn: (opts: { ctx: typeof mockCtx; input: unknown }) => unknown) => ({
          _resolve: fn,
          _inputSchema: schema,
          _ctx: mockCtx,
        }),
        mutation: (fn: (opts: { ctx: typeof mockCtx; input: unknown }) => unknown) => ({
          _resolve: fn,
          _inputSchema: schema,
          _ctx: mockCtx,
        }),
      }),
      query: (fn: (opts: { ctx: typeof mockCtx }) => unknown) => ({
        _resolve: fn,
        _ctx: mockCtx,
      }),
      mutation: (fn: (opts: { ctx: typeof mockCtx }) => unknown) => ({
        _resolve: fn,
        _ctx: mockCtx,
      }),
    };
  }

  return {
    router: (routes: Record<string, unknown>) => routes,
    protectedProcedure: makeProcedure(),
    cachedProtectedQuery: () => makeProcedure(),
    CacheTTL: { SHORT: 120, MEDIUM: 600, LONG: 3600 },
  };
});

describe("journalRouter", () => {
  it("exports a router object with expected procedures", async () => {
    const { journalRouter } = await import("./journal.ts");
    expect(journalRouter).toBeDefined();
    expect(journalRouter.questions).toBeDefined();
    expect(journalRouter.entries).toBeDefined();
    expect(journalRouter.trends).toBeDefined();
    expect(journalRouter.create).toBeDefined();
    expect(journalRouter.update).toBeDefined();
    expect(journalRouter.delete).toBeDefined();
    expect(journalRouter.createQuestion).toBeDefined();
  });
});
