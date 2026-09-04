import { providerRateLimitCooldownStore } from "dofek/jobs/provider-rate-limit-cooldown";
import { ProviderModel } from "dofek/providers/provider-model";
import { getAllProviders } from "dofek/providers/registry";
import { hasCurrentProviderAuthFailure } from "../lib/provider-auth-state.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import { CUSTOM_AUTH_PROVIDERS, ensureProvidersRegistered } from "../routers/sync-helpers.ts";
import type { DofekMcpContext } from "./context.ts";
import { syncHealth } from "./sync-health.ts";

export async function listProviderStatuses(context: Pick<DofekMcpContext, "db" | "userId">) {
  await ensureProvidersRegistered();
  const repository = new SyncRepository(context.db, context.userId);
  const [connectedProviders, lastSyncs, latestErrors, scheduledSyncHealth] = await Promise.all([
    repository.getConnectedProviderIds(),
    repository.getLastSyncTimes(),
    repository.getLatestErrors(),
    repository.getScheduledSyncHealth(),
  ]);
  const connectedProviderIds = new Set(
    connectedProviders
      .filter((provider) => provider.hasTokens)
      .map((provider) => provider.providerId),
  );
  const tokenUpdatedAtMap = new Map(
    connectedProviders.map((provider) => [provider.providerId, provider.updatedAt]),
  );
  const lastSyncMap = new Map(
    lastSyncs.map((provider) => [provider.providerId, provider.lastSynced]),
  );
  const scheduledSyncHealthMap = new Map(
    scheduledSyncHealth.map((health) => [health.providerId, health]),
  );
  const authErrorProviderIds = new Set(
    latestErrors
      .filter((provider) =>
        hasCurrentProviderAuthFailure(
          provider.authFailureReason,
          provider.syncedAt,
          tokenUpdatedAtMap.get(provider.providerId),
        ),
      )
      .map((provider) => provider.providerId),
  );
  const providerModels = getAllProviders()
    .filter((provider) => provider.validate() === null)
    .map(
      (provider) =>
        new ProviderModel(provider, connectedProviderIds, lastSyncMap, CUSTOM_AUTH_PROVIDERS),
    );
  const cooldowns = new Map(
    await Promise.all(
      providerModels
        .filter((model) => model.isConnected && !model.importOnly)
        .map(
          async (model) =>
            [
              model.id,
              await providerRateLimitCooldownStore.getActive(model.id, context.userId),
            ] as const,
        ),
    ),
  );

  return providerModels.map((model) => ({
    id: model.id,
    name: model.name,
    authType: model.authType,
    authorized: model.isConnected,
    lastSyncedAt: model.lastSyncedAt,
    importOnly: model.importOnly,
    needsReauth: authErrorProviderIds.has(model.id),
    sync_health:
      model.isConnected && !model.importOnly
        ? syncHealth(scheduledSyncHealthMap.get(model.id), cooldowns.get(model.id))
        : null,
  }));
}
