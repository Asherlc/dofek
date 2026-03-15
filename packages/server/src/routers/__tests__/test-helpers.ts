import { initTRPC } from "@trpc/server";
import { vi } from "vitest";
import type { Context } from "../../trpc.ts";

// Create a real tRPC instance for testing (without caching/auth middleware)
const t = initTRPC.context<Context>().create();

/**
 * Mocked tRPC exports that replace the real trpc.ts module.
 * Use with: vi.mock("../../trpc.ts", () => trpcMock)
 */
export const trpcMock = {
  router: t.router,
  protectedProcedure: t.procedure,
  cachedProtectedQuery: () => t.procedure,
  cachedProtectedQueryLight: () => t.procedure,
  CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
};

/**
 * Create a caller for a router. The caller can invoke procedures directly.
 */
export function createTestCaller<TRouter extends ReturnType<typeof t.router>>(
  router: TRouter,
  rows: Record<string, unknown>[] = [],
  userId = "test-user-id",
) {
  const callerFactory = t.createCallerFactory(router);
  return callerFactory({
    db: createMockDb(rows),
    userId,
  });
}

/**
 * Create a callerFactory function for a router.
 * Returns a function that takes ctx and produces a caller.
 */
export function createTestCallerFactory<TRouter extends ReturnType<typeof t.router>>(
  router: TRouter,
) {
  return t.createCallerFactory(router);
}

/**
 * Create a mock database that returns the provided rows for execute() calls.
 */
export function createMockDb(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  });
  return { execute, select } as unknown as Context["db"];
}

/**
 * Create a mock context with a mocked DB and an authenticated userId.
 */
export function createMockCtx(
  rows: Record<string, unknown>[] = [],
  userId = "test-user-id",
) {
  return {
    db: createMockDb(rows),
    userId,
  };
}

/**
 * Create a mock DB that returns different rows for sequential execute() calls.
 */
export function createSequentialMockDb(...callResults: Record<string, unknown>[][]) {
  const execute = vi.fn();
  for (let i = 0; i < callResults.length; i++) {
    execute.mockResolvedValueOnce(callResults[i]);
  }
  execute.mockResolvedValue([]);

  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  });
  return { execute, select } as unknown as Context["db"];
}
