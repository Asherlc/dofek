import type { Router } from "express";
import { getConfiguredProviders } from "../../auth/providers.ts";
import { logger } from "../../logger.ts";

export function registerProvidersListRoutes(router: Router): void {
  router.get("/api/auth/providers", async (req, res) => {
    try {
      const identityProviders = getConfiguredProviders();
      const { getAllProviders } = await import("dofek/providers/registry");
      const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
      await ensureProvidersRegistered();

      const dataLoginProviders = getAllProviders()
        .filter((p) => {
          try {
            const setup = p.authSetup?.({ host: req.get("host") });
            return setup?.getUserIdentity && setup.oauthConfig;
          } catch (err: unknown) {
            logger.warn(`[auth] Skipping ${p.id} for login: authSetup() threw: ${err}`);
            return false;
          }
        })
        .map((p) => p.id);

      res.json({ identity: identityProviders, data: dataLoginProviders });
    } catch (err: unknown) {
      logger.error(`[auth] Failed to list providers: ${err}`);
      res.json({ identity: getConfiguredProviders(), data: [] });
    }
  });
}
