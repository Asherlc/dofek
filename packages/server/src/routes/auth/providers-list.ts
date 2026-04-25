import { IDENTITY_PROVIDER_NAMES } from "@dofek/auth/auth";
import { captureException } from "@sentry/node";
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

        const validation = provider.validate?.() ?? null;
        if (validation !== null) {
          skippedDataProviders.push(`${provider.id}(not configured: ${validation})`);
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
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to initialize auth provider ${provider.id}: ${message}`);
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    captureException(error);
    logger.error(`[auth] Failed to list providers: ${message}`);
    res.status(500).send(message);
  }
}
