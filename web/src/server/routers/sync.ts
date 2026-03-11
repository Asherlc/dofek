import { getAllProviders, registerProvider } from "dofek/providers/registry";
import { runSync } from "dofek/sync/runner";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.js";

// Register providers on first import
let providersRegistered = false;

async function ensureProvidersRegistered() {
  if (providersRegistered) return;
  providersRegistered = true;

  // Dynamically import providers — they self-validate via env vars
  try {
    const { WahooProvider } = await import("dofek/providers/wahoo");
    registerProvider(new WahooProvider());
  } catch {}
  try {
    const { WithingsProvider } = await import("dofek/providers/withings");
    registerProvider(new WithingsProvider());
  } catch {}
  try {
    const { PelotonProvider } = await import("dofek/providers/peloton");
    registerProvider(new PelotonProvider());
  } catch {}
  try {
    const { FatSecretProvider } = await import("dofek/providers/fatsecret");
    registerProvider(new FatSecretProvider());
  } catch {}
}

export const syncRouter = router({
  /** List all providers and whether they're enabled (have valid config) */
  providers: publicProcedure.query(async () => {
    await ensureProvidersRegistered();
    const all = getAllProviders();
    return all.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.validate() === null,
      error: p.validate(),
    }));
  }),

  /** Trigger sync for a specific provider or all enabled providers */
  triggerSync: publicProcedure
    .input(
      z.object({
        providerId: z.string().optional(),
        sinceDays: z.number().default(7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();
      const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000);

      if (input.providerId) {
        const provider = getAllProviders().find((p) => p.id === input.providerId);
        if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
        const validation = provider.validate();
        if (validation) throw new Error(`Provider not configured: ${validation}`);
        return runSync(ctx.db, since, [provider]);
      }

      return runSync(ctx.db, since);
    }),
});
