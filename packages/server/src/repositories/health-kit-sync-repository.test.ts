import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { getProviderDataGenerations } from "../../../../src/db/provider-data-deletion.ts";
import type { MetricStreamEventPublisher } from "../../../../src/metric-stream/redpanda-producer.ts";
import {
  HealthKitDeletionTombstonesUnsupportedError,
  HealthKitSyncRepository,
} from "./health-kit-sync-repository.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../../../../src/db/provider-data-deletion.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: vi.fn(resolveProviderDataGenerationsForTest) };
});

describe("HealthKitSyncRepository", () => {
  function makeRepository() {
    const execute = vi.fn().mockResolvedValue([]);
    const db = makeTransactionalTestDatabase({ execute });
    const publisher = { publishRows: vi.fn(async () => []) };
    const repository = new HealthKitSyncRepository(db, "user-1", publisher);
    return { repository, execute, publisher };
  }
  describe("processDeletedQuantitySamples", () => {
    it("does nothing when the anchored query has no deleted UUIDs", async () => {
      vi.mocked(getProviderDataGenerations).mockClear();
      const { repository, execute } = makeRepository();

      await expect(
        repository.processDeletedQuantitySamples("HKQuantityTypeIdentifierHeartRate", []),
      ).resolves.toBe(0);

      expect(execute).not.toHaveBeenCalled();
      expect(getProviderDataGenerations).not.toHaveBeenCalled();
    });

    it("fails when the metric stream publisher cannot emit deletion tombstones", async () => {
      const repository = new HealthKitSyncRepository(
        { execute: vi.fn().mockResolvedValue([]) },
        "user-1",
        { publishRows: vi.fn(async () => []) },
      );

      await expect(
        repository.processDeletedQuantitySamples("HKQuantityTypeIdentifierHeartRate", [
          "heart-rate-1",
        ]),
      ).rejects.toBeInstanceOf(HealthKitDeletionTombstonesUnsupportedError);
    });

    it("publishes provider-scoped tombstones concurrently for unique UUIDs", async () => {
      vi.mocked(getProviderDataGenerations).mockClear();
      const releases: Array<() => void> = [];
      const publisher: MetricStreamEventPublisher = {
        publishRows: vi.fn(async () => []),
        replaceRows: vi.fn(async (scope, rows, operationRevision) => {
          await new Promise<void>((resolve) => releases.push(resolve));
          return {
            deleted: {
              version: 3 as const,
              eventType: "metric_stream_deleted" as const,
              eventId: "00000000-0000-4000-8000-000000000001",
              operationRevision,
              scope,
              partitionKey: "test",
            },
            rows: [...rows],
          };
        }),
      };
      const execute = vi.fn().mockResolvedValue([]);
      const repository = new HealthKitSyncRepository(
        makeTransactionalTestDatabase({ execute }),
        "user-1",
        publisher,
      );

      const deletion = repository.processDeletedQuantitySamples(
        "HKQuantityTypeIdentifierHeartRate",
        ["heart-rate-1", "heart-rate-2", "heart-rate-1"],
      );

      await vi.waitFor(() => {
        expect(publisher.replaceRows).toHaveBeenCalledTimes(2);
      });
      expect(getProviderDataGenerations).toHaveBeenLastCalledWith(
        expect.objectContaining({ execute }),
        [
          {
            providerId: "apple_health",
            userId: "user-1",
          },
        ],
      );
      expect(publisher.replaceRows).toHaveBeenNthCalledWith(
        1,
        {
          externalId: "hk:heart-rate-1",
          providerId: "apple_health",
          userId: "user-1",
        },
        [],
        "1000000000000000",
      );
      expect(publisher.replaceRows).toHaveBeenNthCalledWith(
        2,
        {
          externalId: "hk:heart-rate-2",
          providerId: "apple_health",
          userId: "user-1",
        },
        [],
        "1000000000000000",
      );

      for (const release of releases) {
        release();
      }
      await expect(deletion).resolves.toBe(2);
    });

    it("invokes tombstone publishing with the publisher instance bound", async () => {
      const publisher: MetricStreamEventPublisher & { calls: number } = {
        calls: 0,
        publishRows: vi.fn(async () => []),
        async replaceRows(scope, rows, operationRevision) {
          this.calls += 1;
          return {
            deleted: {
              version: 3 as const,
              eventType: "metric_stream_deleted" as const,
              eventId: "00000000-0000-4000-8000-000000000001",
              operationRevision,
              scope,
              partitionKey: "test",
            },
            rows: [...rows],
          };
        },
      };
      const repository = new HealthKitSyncRepository(
        { execute: vi.fn().mockResolvedValue([]) },
        "user-1",
        publisher,
      );

      await expect(
        repository.processDeletedQuantitySamples("HKQuantityTypeIdentifierHeartRate", [
          "heart-rate-1",
        ]),
      ).resolves.toBe(1);
      expect(publisher.calls).toBe(1);
    });

    it("deletes UUID-addressed HealthKit events through typed repository SQL", async () => {
      const execute = vi.fn().mockResolvedValue([{ externalId: "hk:vo2-max-1" }]);
      const publisher: MetricStreamEventPublisher = {
        publishRows: vi.fn(async () => []),
        replaceRows: vi.fn(),
      };
      const repository = new HealthKitSyncRepository(
        makeTransactionalTestDatabase({ execute }),
        "user-1",
        publisher,
      );

      await expect(
        repository.processDeletedQuantitySamples("HKQuantityTypeIdentifierVO2Max", ["vo2-max-1"]),
      ).resolves.toBe(1);

      expect(publisher.replaceRows).not.toHaveBeenCalled();
      expect(JSON.stringify(execute.mock.calls)).toContain("fitness.health_event");
      expect(JSON.stringify(execute.mock.calls)).toContain("hk:vo2-max-1");
    });

    it("returns the actual number of deleted HealthKit event rows", async () => {
      const execute = vi.fn().mockResolvedValue([{ externalId: "hk:vo2-max-1" }]);
      const repository = new HealthKitSyncRepository(
        makeTransactionalTestDatabase({ execute }),
        "user-1",
      );

      await expect(
        repository.processDeletedQuantitySamples("HKQuantityTypeIdentifierVO2Max", [
          "vo2-max-1",
          "vo2-max-2",
        ]),
      ).resolves.toBe(1);
    });

    it("rejects an invalid typed deletion result", async () => {
      const repository = new HealthKitSyncRepository(
        { execute: vi.fn().mockResolvedValue([{}]) },
        "user-1",
      );

      await expect(
        repository.processDeletedQuantitySamples("HKQuantityTypeIdentifierVO2Max", ["vo2-max-1"]),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });
});
