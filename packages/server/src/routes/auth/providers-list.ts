import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import type { Request, Response } from "express";
import {
  getConfiguredProviders,
  isNativeAppleConfigured,
  isProviderConfigured,
} from "../../auth/providers.ts";
import { logger } from "../../logger.ts";

export async function handleGetAuthProviders(req: Request, res: Response): Promise<void> {
  try {
    const identityProviders = getConfiguredProviders();

    for (const name of IDENTITY_PROVIDER_NAMES) {
      if (!isProviderConfigured(name)) {
        logger.warn(`[auth] Identity provider ${name} is not configured (missing env vars)`);
      }
    }

    const { getAllProviders } = await import("dofek/providers/registry");
    const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
    await ensureProvidersRegistered();

    const allRegistered = getAllProviders();
    const dataLoginProviders = allRegistered
      .filter((provider) => {
        if (!provider.authSetup) {
          return false;
        }
        try {
          const setup = provider.authSetup({ host: req.get("host") });
          if (!setup) {
            logger.warn(`[auth] ${provider.id}: authSetup() returned undefined (missing env vars)`);
            return false;
          }
          if (!setup.getUserIdentity) {
            return false;
          }
          if (!setup.oauthConfig) {
            logger.warn(
              `[auth] ${provider.id}: authSetup() has getUserIdentity but no oauthConfig`,
            );
            return false;
          }
          return true;
        } catch (err: unknown) {
          logger.warn(`[auth] Skipping ${provider.id} for login: authSetup() threw: ${err}`);
          return false;
        }
      })
      .map((provider) => provider.id);

    logger.info(
      `[auth] Login providers: identity=[${identityProviders.join(",")}] data=[${dataLoginProviders.join(",")}] (${allRegistered.length} total registered)`,
    );

    res.json({
      identity: identityProviders,
      data: dataLoginProviders,
      nativeApple: isNativeAppleConfigured(),
    });
  } catch (err: unknown) {
    logger.error(`[auth] Failed to list providers: ${err}`);
    res.json({
      identity: getConfiguredProviders(),
      data: [],
      nativeApple: isNativeAppleConfigured(),
    });
  }
}
