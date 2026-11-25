import {
  ghostSessionsCompareInputSchema,
  ghostSessionsCompareResponseSchema,
  ghostSessionsGetInputSchema,
  ghostSessionsGetResponseSchema,
  ghostSessionsPassesInputSchema,
  ghostSessionsPassesResponseSchema,
} from "@dofek/training/ghost-sessions";
import {
  createGhostSessionsRepository,
  type GhostSessionsRepository,
} from "../repositories/ghost-sessions-repository.ts";
import { type AuthenticatedContext, protectedProcedure, router } from "../trpc.ts";

export function createGhostSessionsRouter(
  createRepository: (
    context: AuthenticatedContext,
  ) => Pick<GhostSessionsRepository, "get" | "passes" | "compare">,
) {
  return router({
    get: protectedProcedure
      .input(ghostSessionsGetInputSchema)
      .output(ghostSessionsGetResponseSchema)
      .query(({ ctx, input }) => createRepository(ctx).get(input)),
    passes: protectedProcedure
      .input(ghostSessionsPassesInputSchema)
      .output(ghostSessionsPassesResponseSchema)
      .query(({ ctx, input }) => createRepository(ctx).passes(input)),
    compare: protectedProcedure
      .input(ghostSessionsCompareInputSchema)
      .output(ghostSessionsCompareResponseSchema)
      .query(({ ctx, input }) => createRepository(ctx).compare(input)),
  });
}

export const ghostSessionsRouter = createGhostSessionsRouter(createGhostSessionsRepository);
