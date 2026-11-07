import { z } from "zod";

/**
 * Operator acknowledgement that stock transport physical maintenance (runbook
 * inventories / retention cutoffs) covers this request. Recorded under existing
 * `phase_progress.retention_verification` via existing admin/progress paths — not a
 * certificate framework and not automated host proof. Kafka tiered-storage physical
 * cleanup remains slice-2 qualification; keep this fail-closed contract until then.
 */
export const stockPhysicalMaintenanceAckSchema = z.strictObject({
  kind: z.literal("stock_physical_maintenance_ack"),
  runId: z.string().min(1).max(128),
  operator: z.string().min(1).max(128),
  verifiedAt: z.string().datetime({ offset: true }),
  verifiedCutoffAt: z.string().datetime({ offset: true }),
  runbookRevision: z.string().min(1).max(256),
});

export type StockPhysicalMaintenanceAck = z.infer<typeof stockPhysicalMaintenanceAckSchema>;

export type PhysicalMaintenanceAcknowledgedSummary = {
  runId: string;
  operator: string;
  runbookRevision: string;
};

/**
 * Fail closed unless the operator ack is present and ordered:
 * durable ingest_fence.completed_at ≤ verifiedCutoffAt ≤ verifiedAt ≤ now.
 * TTL elapsed alone never creates or satisfies this acknowledgement.
 */
export function requireStockPhysicalMaintenanceAck(
  progress: unknown,
  options: {
    ingestFenceCompletedAt: Date;
    now: Date;
  },
): StockPhysicalMaintenanceAck {
  const ack = stockPhysicalMaintenanceAckSchema.parse(progress);
  const cutoffMs = Date.parse(ack.verifiedCutoffAt);
  const verifiedAtMs = Date.parse(ack.verifiedAt);
  const fenceMs = options.ingestFenceCompletedAt.getTime();
  const nowMs = options.now.getTime();
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(verifiedAtMs)) {
    throw new Error("Stock physical maintenance ack timestamps must be valid date-times");
  }
  if (!(cutoffMs >= fenceMs)) {
    throw new Error(
      "Stock physical maintenance verifiedCutoffAt must cover durable ingest_fence.completed_at",
    );
  }
  if (!(cutoffMs <= verifiedAtMs)) {
    throw new Error("Stock physical maintenance verifiedCutoffAt must be at or before verifiedAt");
  }
  if (!(verifiedAtMs <= nowMs)) {
    throw new Error("Stock physical maintenance verifiedAt must be at or before now");
  }
  return ack;
}

export function summarizePhysicalMaintenanceAcknowledged(
  ack: StockPhysicalMaintenanceAck,
): PhysicalMaintenanceAcknowledgedSummary {
  return {
    runId: ack.runId,
    operator: ack.operator,
    runbookRevision: ack.runbookRevision,
  };
}
