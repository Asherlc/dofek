import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KafkaLogStorage } from "./kafka-log-storage.ts";

const topicId = "dI2O6HVWQkuC7XgSy7cJ3w";
const clusterId = "MkU3OEVBNTcwNTJENDM2Qk";
const directories: string[] = [];
const offsets = [{ partition: 0, low: "100", high: "200", offset: "200" }];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kafka-erasure-"));
  directories.push(root);
  const logs = join(root, "logs");
  const retired = join(root, "retired");
  const partition = join(logs, "samples-0");
  await mkdir(partition, { recursive: true });
  await mkdir(retired);
  await writeFile(join(logs, "meta.properties"), `version=1\ncluster.id=${clusterId}\nnode.id=1\n`);
  await writeFile(join(partition, "partition.metadata"), `version: 0\ntopic_id: ${topicId}\n`);
  await writeFile(join(partition, "00000000000000000100.log"), "newer records");
  const admin = {
    fetchTopicMetadata: vi.fn(async () => ({
      topics: [
        {
          name: "samples",
          partitions: [
            { partitionId: 0, partitionErrorCode: 0, replicas: [1], isr: [1], leader: 1 },
          ],
        },
      ],
    })),
    describeCluster: vi.fn(async () => ({
      clusterId,
      controller: 1,
      brokers: [{ nodeId: 1, host: "kafka", port: 9092 }],
    })),
    describeConfigs: vi.fn(async () => ({
      resources: [
        {
          errorCode: 0,
          errorMessage: null,
          resourceType: 4,
          resourceName: "1",
          configEntries: [
            { configName: "log.dirs", configValue: "/var/lib/kafka/data" },
            { configName: "remote.log.storage.system.enable", configValue: "false" },
          ],
        },
      ],
    })),
  };
  const storage = new KafkaLogStorage(admin, {
    directory: logs,
    brokerDirectory: "/var/lib/kafka/data",
    retiredDirectory: retired,
    topics: ["samples"],
  });
  const boundaries = await storage.capture("samples", async () => offsets);
  const boundary = boundaries[0];
  if (!boundary) throw new Error("missing fixture boundary");
  const retained: [typeof boundary] = [boundary];
  return { admin, storage, logs, partition, retired, boundaries: retained };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Kafka native log erasure", () => {
  it("binds offsets to the native cluster and topic generation", async () => {
    const { boundaries } = await fixture();
    expect(boundaries).toEqual([{ ...offsets[0], clusterId, topicId }]);
  });

  it.each([
    "log",
    "log.deleted",
    "log.swap",
    "log.cleaned",
    "index",
    "timeindex",
    "txnindex",
    "snapshot",
  ])("blocks while an old %s file remains despite logical expiry", async (suffix) => {
    const { storage, partition, boundaries } = await fixture();
    const file = join(partition, `00000000000000000000.${suffix}`);
    await writeFile(file, "retained bytes");
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("retains segment");
    await rm(file);
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).resolves.toBeUndefined();
  });

  it.each(["delete", "future", "stray"])("blocks a %s replica directory", async (suffix) => {
    const { storage, logs, boundaries } = await fixture();
    await mkdir(join(logs, `samples-0.abc-${suffix}`));
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("non-current replica");
  });

  it("blocks topic recreation instead of comparing different generations' offsets", async () => {
    const { storage, partition, boundaries } = await fixture();
    await writeFile(
      join(partition, "partition.metadata"),
      "version: 0\ntopic_id: aaaaaaaaaaaaaaaaaaaaaa\n",
    );
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("generation");
  });

  it("detects recreation during offset capture", async () => {
    const { storage, partition } = await fixture();
    await expect(
      storage.capture("samples", async () => {
        await writeFile(
          join(partition, "partition.metadata"),
          "version: 0\ntopic_id: aaaaaaaaaaaaaaaaaaaaaa\n",
        );
        return offsets;
      }),
    ).rejects.toThrow("generation");
  });

  it("blocks final verification while any retired broker entry remains", async () => {
    const { storage, retired, boundaries } = await fixture();
    await mkdir(join(retired, "redpanda"));
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("Retired broker");
  });

  it("rejects missing old-generation evidence", async () => {
    const { storage } = await fixture();
    await expect(
      storage.assertExpired([{ topic: "samples", partition: 0, low: "0", offset: "100" }]),
    ).rejects.toThrow("generation");
  });

  it("rejects unknown related files and symlinks", async () => {
    const { storage, partition, boundaries } = await fixture();
    const unknown = join(partition, "payload.bak");
    await writeFile(unknown, "unknown retained data");
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("Unknown Kafka");
    await rm(unknown);
    await symlink("00000000000000000100.log", unknown);
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("Unknown Kafka");
  });

  it("rejects missing or malformed native metadata", async () => {
    const { storage, logs } = await fixture();
    const metadata = join(logs, "meta.properties");
    const original = await readFile(metadata, "utf8");
    await writeFile(metadata, original.replace(clusterId, "wrong"));
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow("cluster");
    await rm(metadata);
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow();
  });

  it.each(["log.dirs", "remote.log.storage.system.enable"])(
    "rejects unsupported broker %s",
    async (key) => {
      const { storage, admin, boundaries } = await fixture();
      const response = await admin.describeConfigs();
      const resource = response.resources[0];
      if (!resource) throw new Error("missing fixture resource");
      const entry = resource.configEntries.find((entry) => entry.configName === key);
      if (!entry) throw new Error("missing fixture key");
      entry.configValue = key === "log.dirs" ? "/var/lib/kafka/data,/other" : "true";
      admin.describeConfigs.mockResolvedValue(response);
      await expect(
        storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
      ).rejects.toThrow(key);
    },
  );

  it("rejects additional brokers", async () => {
    const { storage, admin } = await fixture();
    const response = await admin.describeCluster();
    response.brokers.push({ nodeId: 2, host: "other", port: 9092 });
    admin.describeCluster.mockResolvedValue(response);
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow("single broker");
  });

  it("rejects an extra on-disk partition even when metadata reports only one", async () => {
    const { storage, logs, boundaries } = await fixture();
    await mkdir(join(logs, "samples-1"));
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("non-current replica");
  });

  it("rejects an extra replica", async () => {
    const { storage, admin, boundaries } = await fixture();
    const metadata = await admin.fetchTopicMetadata();
    const partition = metadata.topics[0]?.partitions[0];
    if (!partition) throw new Error("missing fixture partition");
    partition.replicas.push(2);
    admin.fetchTopicMetadata.mockResolvedValue(metadata);
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("replica");
  });

  it.each([{ partitionId: 1 }, { partitionErrorCode: 5 }, { isr: [] }, { leader: 2 }])(
    "rejects an unavailable or reassigned partition: %j",
    async (change) => {
      const { storage, admin, boundaries } = await fixture();
      const metadata = await admin.fetchTopicMetadata();
      const partition = metadata.topics[0]?.partitions[0];
      if (!partition) throw new Error("missing fixture partition");
      Object.assign(partition, change);
      admin.fetchTopicMetadata.mockResolvedValue(metadata);
      await expect(
        storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
      ).rejects.toThrow("replica");
    },
  );

  it("rejects a controller outside the qualified broker", async () => {
    const { storage, admin } = await fixture();
    const cluster = await admin.describeCluster();
    cluster.controller = 2;
    admin.describeCluster.mockResolvedValue(cluster);
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow("single broker");
  });

  it.each(["version=2", "node.id=2", "cluster.id=other", "version=1\nversion=1"])(
    "rejects unsupported or ambiguous native broker metadata: %s",
    async (metadata) => {
      const { storage, logs } = await fixture();
      await writeFile(join(logs, "meta.properties"), metadata);
      await expect(storage.capture("samples", async () => offsets)).rejects.toThrow();
    },
  );

  it.each([
    "version: 1\ntopic_id: dI2O6HVWQkuC7XgSy7cJ3w",
    "version: 0\ntopic_id: invalid",
    "version: 0\ntopic_id: dI2O6HVWQkuC7XgSy7cJ3w\nunknown line",
  ])("rejects unsupported native topic metadata: %s", async (metadata) => {
    const { storage, partition } = await fixture();
    await writeFile(join(partition, "partition.metadata"), metadata);
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow();
  });

  it("rejects a partial checkpoint set", async () => {
    const { storage } = await fixture();
    await expect(storage.assertExpired([])).rejects.toThrow("checkpoints");
  });

  it("rejects a missing retired storage mount rather than treating it as empty", async () => {
    const { storage, retired, boundaries } = await fixture();
    await rm(retired, { recursive: true });
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow();
  });
});
