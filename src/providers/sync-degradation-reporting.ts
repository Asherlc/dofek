import { captureMessage } from "@sentry/node";
import { logger } from "../logger.ts";
import type { SyncDegradation, SyncDegradationContext } from "./sync-degradation.ts";

function isSafeContextKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes("raw")) return false;
  if (lowerKey.includes("token")) return false;
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
    kind: degradation.kind,
    providerId: degradation.providerId,
    stepName: degradation.stepName,
    message: degradation.message,
    externalId: degradation.externalId ?? null,
    ...context,
  };

  logger.warn("[provider-sync] Degraded provider sync step", details);
  captureMessage("Provider sync degraded", {
    level: "warning",
    tags: {
      providerId: degradation.providerId,
      stepName: degradation.stepName,
      degradationKind: degradation.kind,
    },
    extra: details,
  });
}
