import { logger } from "../logger.ts";
import { syncDegradationsTotal } from "../sync-metrics.ts";
import type { SyncDegradation, SyncDegradationContext } from "./sync-degradation.ts";

const sensitiveContextKeySubstrings = ["auth", "password", "raw", "secret", "token"];

function isSafeContextKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  if (sensitiveContextKeySubstrings.some((substring) => lowerKey.includes(substring))) {
    return false;
  }
  if (lowerKey.includes("cursor") && !lowerKey.includes("fingerprint")) return false;
  return true;
}

function safeContext(context: SyncDegradationContext | undefined): SyncDegradationContext {
  if (!context) return {};

  const safeEntries: Array<[string, string | number | boolean | null]> = [];
  for (const [key, value] of Object.entries(context)) {
    if (isSafeContextKey(key)) {
      safeEntries.push([key, value]);
    }
  }
  return Object.fromEntries(safeEntries);
}

export function reportSyncDegradation(degradation: SyncDegradation): void {
  const context = safeContext(degradation.context);
  const details = {
    ...context,
    kind: degradation.kind,
    providerId: degradation.providerId,
    stepName: degradation.stepName,
    message: degradation.message,
    externalId: degradation.externalId ?? null,
  };

  logger.warn("[provider-sync] Degraded provider sync step", details);
  syncDegradationsTotal.add(1, {
    provider: degradation.providerId,
    step_name: degradation.stepName,
    degradation_kind: degradation.kind,
  });
}
