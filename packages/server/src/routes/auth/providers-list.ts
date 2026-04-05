import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import type { Request, Response } from "express";
import {
  getConfiguredProviders,
  isNativeAppleConfigured,
  isProviderConfigured,
} from "../../auth/providers.ts";
import { logger } from "../../logger.ts";

let hasLoggedProviderDiagnostics = false;

export async function handleGetAuthProviders(req: Request, res: Response): Promise<void> {
  try {
    const identityProviders = getConfiguredProviders();

    const { getAllProviders } = await import("dofek/providers/registry");
    const { ensureProvidersRegistered } = await import("../../routers/sync.ts");
    await ensureProvidersRegistered();

    const allRegistered = getAllProviders();
    const skippedDataProviders: string[] = [];
    const dataLoginProviders = allRegistered
      .filter((provider) => {
        if (!provider.authSetup) {
          return false;
        }
        try {
          const setup = provider.authSetup({ host: req.get("host") });
          if (!setup) {
            skippedDataProviders.push(`${provider.id}(no setup)`);
            return false;
          }
          if (!setup.getUserIdentity) {
            return false;
          }
          if (!setup.oauthConfig) {
            skippedDataProviders.push(`${provider.id}(no oauthConfig)`);
            return false;
          }
          return true;
        } catch (err: unknown) {
          skippedDataProviders.push(`${provider.id}(threw: ${err})`);
          return false;
        }
      })
      .map((provider) => provider.id);

    if (!hasLoggedProviderDiagnostics) {
      hasLoggedProviderDiagnostics = true;

      const missingIdentityProviders = IDENTITY_PROVIDER_NAMES.filter(
        (name) => !isProviderConfigured(name),
      );
      if (missingIdentityProviders.length > 0) {
        logger.warn(
          `[auth] Identity providers not configured (missing env vars): ${missingIdentityProviders.join(", ")}`,
        );
      }
      if (skippedDataProviders.length > 0) {
        logger.warn(`[auth] Data login providers skipped: ${skippedDataProviders.join(", ")}`);
      }
      logger.info(
        `[auth] Login providers: identity=[${identityProviders.join(",")}] data=[${dataLoginProviders.join(",")}] (${allRegistered.length} total registered)`,
      );
    }

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
