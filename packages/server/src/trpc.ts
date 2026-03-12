import { initTRPC } from "@trpc/server";
import { middlewareMarker } from "@trpc/server/unstable-core-do-not-import";
import type { Database } from "dofek/db";
import { queryCache } from "./lib/cache.ts";
import { trpcProcedureDuration } from "./lib/metrics.ts";

export interface Context {
  db: Database;
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const CacheTTL = {
  SHORT: 2 * 60 * 1000, // 2 min
  MEDIUM: 10 * 60 * 1000, // 10 min
  LONG: 60 * 60 * 1000, // 1 hour
} as const;

function cached(ttlMs: number) {
  return t.middleware(async ({ path, type, getRawInput, next }) => {
    const start = performance.now();
    const rawInput = await getRawInput();
    const key = `${path}:${JSON.stringify(rawInput)}`;
    const hit = await queryCache.get(key);
    if (hit !== undefined) {
      trpcProcedureDuration.observe(
        { procedure: path, type, cache_hit: "true" },
        (performance.now() - start) / 1000,
      );
      return { ok: true as const, data: hit, marker: middlewareMarker };
    }

    const result = await next();
    trpcProcedureDuration.observe(
      { procedure: path, type, cache_hit: "false" },
      (performance.now() - start) / 1000,
    );
    if (result.ok) {
      await queryCache.set(key, result.data, ttlMs);
    }
    return result;
  });
}

export const cachedQuery = (ttl: number) => publicProcedure.use(cached(ttl));
