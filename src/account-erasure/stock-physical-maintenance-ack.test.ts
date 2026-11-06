import { describe, expect, it } from "vitest";
import {
  requireStockPhysicalMaintenanceAck,
  stockPhysicalMaintenanceAckSchema,
  summarizePhysicalMaintenanceAcknowledged,
} from "./stock-physical-maintenance-ack.ts";

const fenceAt = new Date("2026-11-05T12:00:00.000Z");
const cutoff = "2026-11-05T13:00:00.000Z";
const verifiedAt = "2026-11-05T14:00:00.000Z";
const now = new Date("2026-11-05T15:00:00.000Z");

function ack(overrides: Record<string, unknown> = {}) {
  return stockPhysicalMaintenanceAckSchema.parse({
    kind: "stock_physical_maintenance_ack",
    runId: "maintenance-2026-11-05",
    operator: "oncall@example.com",
    verifiedAt,
    verifiedCutoffAt: cutoff,
    runbookRevision: "docs/pulsar-remaining-work.md#physical",
    ...overrides,
  });
}

describe("requireStockPhysicalMaintenanceAck", () => {
  it("accepts ordered operator ack and summarizes without claiming host proof", () => {
    const value = requireStockPhysicalMaintenanceAck(ack(), {
      ingestFenceCompletedAt: fenceAt,
      now,
    });
    expect(summarizePhysicalMaintenanceAcknowledged(value)).toEqual({
      runId: "maintenance-2026-11-05",
      operator: "oncall@example.com",
      runbookRevision: "docs/pulsar-remaining-work.md#physical",
    });
  });

  it("rejects missing ack, legacy physical evidence shapes, and TTL-only markers", () => {
    expect(() =>
      requireStockPhysicalMaintenanceAck(null, { ingestFenceCompletedAt: fenceAt, now }),
    ).toThrow();
    expect(() =>
      requireStockPhysicalMaintenanceAck(
        { status: "verified", requestId: "11111111-1111-4111-8111-111111111111" },
        { ingestFenceCompletedAt: fenceAt, now },
      ),
    ).toThrow();
    expect(() =>
      requireStockPhysicalMaintenanceAck(
        { waitingRetention: true },
        { ingestFenceCompletedAt: fenceAt, now },
      ),
    ).toThrow();
  });

  it("requires verifiedCutoffAt >= ingest_fence.completed_at and cutoff <= verifiedAt <= now", () => {
    expect(() =>
      requireStockPhysicalMaintenanceAck(ack({ verifiedCutoffAt: "2026-11-05T11:00:00.000Z" }), {
        ingestFenceCompletedAt: fenceAt,
        now,
      }),
    ).toThrow(/cover durable ingest_fence/);
    expect(() =>
      requireStockPhysicalMaintenanceAck(
        ack({ verifiedCutoffAt: "2026-11-05T14:30:00.000Z", verifiedAt }),
        { ingestFenceCompletedAt: fenceAt, now },
      ),
    ).toThrow(/at or before verifiedAt/);
    expect(() =>
      requireStockPhysicalMaintenanceAck(ack({ verifiedAt: "2026-11-05T16:00:00.000Z" }), {
        ingestFenceCompletedAt: fenceAt,
        now,
      }),
    ).toThrow(/at or before now/);
  });
});
