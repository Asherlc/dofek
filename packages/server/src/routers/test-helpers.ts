import type { AnyRouter } from "@trpc/server";
import { initTRPC } from "@trpc/server";
import type { Context } from "../trpc.ts";

// Create a real tRPC instance for testing (without caching/auth middleware)
const t = initTRPC.context<Context>().create();

/**
 * Create a callerFactory function for a router.
 * Returns a function that takes ctx and produces a caller.
 *
 * Uses AnyRouter because the mock vi.mock factory creates routers from a
 * different tRPC instance, making types structurally incompatible at compile
 * time despite being equivalent at runtime.
 */
export function createTestCallerFactory(router: AnyRouter) {
  return t.createCallerFactory(router);
}
