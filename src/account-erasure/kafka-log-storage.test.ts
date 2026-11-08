import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KafkaLogStorage } from "./kafka-log-storage.ts";

const topicId = "dI2O6HVWQkuC7XgSy7cJ3w";
const clusterId = "0000000000000000000000";
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
  await mkdir(join(logs, "remote-log-index-cache"));
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
            { configName: "remote.log.storage.system.enable", configValue: "true" },
            {
              configName: "remote.log.storage.manager.class.name",
              configValue: "io.aiven.kafka.tieredstorage.RemoteStorageManager",
            },
            {
              configName: "remote.log.metadata.manager.class.name",
              configValue:
                "org.apache.kafka.server.log.remote.metadata.storage.TopicBasedRemoteLogMetadataManager",
            },
          ],
        },
      ],
    })),
  };
  const remote = {
    assertExpired: vi.fn(
      async () => new Map<string, { topic: string; topicId: string; startOffset: string }>(),
    ),
  };
  const storage = new KafkaLogStorage(
    admin,
    {
      directory: logs,
      brokerDirectory: "/var/lib/kafka/data",
      retiredDirectories: [retired],
      topics: ["samples"],
    },
    remote,
  );
  const boundaries = await storage.capture("samples", async () => offsets);
  const boundary = boundaries[0];
  if (!boundary) throw new Error("missing fixture boundary");
  const retained: [typeof boundary] = [boundary];
  return { admin, storage, remote, logs, partition, retired, boundaries: retained };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Kafka native log erasure", () => {
  it("rejects an unqualified remote storage plugin", async () => {
    const { admin, storage } = await fixture();
    const response = await admin.describeConfigs();
    const entry = response.resources[0]?.configEntries.find(
      (entry) => entry.configName === "remote.log.storage.manager.class.name",
    );
    if (!entry) throw new Error("missing fixture plugin");
    entry.configValue = "other.Plugin";
    admin.describeConfigs.mockResolvedValue(response);
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow("plugin");
  });
  it("cannot complete when native tiered deletion or R2 verification fails", async () => {
    const { storage, remote, boundaries } = await fixture();
    remote.assertExpired.mockRejectedValue(new Error("R2 retains covered object"));
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("retains covered object");
  });

  it("blocks covered or unknown remote index cache files", async () => {
    const { storage, remote, logs, boundaries } = await fixture();
    const file = join(logs, "remote-log-index-cache", "0_AAAAAAAAAAAAAAAAAAAAAQ.index");
    await writeFile(file, "offset index");
    const cut = [{ ...boundaries[0], topic: "samples", offset: "100" }];
    await expect(storage.assertExpired(cut)).rejects.toThrow("remote index");
    remote.assertExpired.mockResolvedValue(
      new Map([["AAAAAAAAAAAAAAAAAAAAAQ", { topic: "samples", topicId, startOffset: "0" }]]),
    );
    await expect(storage.assertExpired(cut)).rejects.toThrow("remote index");
    await rm(file);
    await expect(storage.assertExpired(cut)).resolves.toBeUndefined();
  });
  it("binds offsets to the native cluster and topic generation", async () => {
    const { boundaries, admin } = await fixture();
    expect(boundaries).toEqual([{ ...offsets[0], clusterId, topicId }]);
    expect(admin.describeConfigs).toHaveBeenCalledWith({
      includeSynonyms: false,
      resources: [
        {
          type: 4,
          name: "1",
          configNames: [
            "log.dirs",
            "remote.log.storage.system.enable",
            "remote.log.storage.manager.class.name",
            "remote.log.metadata.manager.class.name",
          ],
        },
      ],
    });
    expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({ topics: ["samples"] });
  });

  it("accepts native comments, whitespace and leader metadata", async () => {
    const { storage, logs, partition, boundaries } = await fixture();
    await writeFile(
      join(logs, "meta.properties"),
      `  # native metadata\n \n version = 1 \ncluster.id : ${clusterId}\nnode.id=1\n`,
    );
    await writeFile(join(partition, "leader-epoch-checkpoint"), "0\n1\n0 0\n");
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).resolves.toBeUndefined();
  });

  it.each([
    "invalid prefix version=1",
    "version=1 trailing",
    "version=1\nversion=1",
    "=invalid",
    "version=",
  ])("rejects malformed or duplicate properties: %s", async (line) => {
    const { storage, logs } = await fixture();
    await writeFile(
      join(logs, "meta.properties"),
      `version=1\ncluster.id=${clusterId}\nnode.id=1\n${line}\n`,
    );
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow(
      "Malformed Kafka native metadata",
    );
  });

  it.each([{ resourceName: "other" }, { resourceType: 2 }, { errorCode: 5 }])(
    "rejects missing or failed broker config identity: %j",
    async (change) => {
      const { storage, admin } = await fixture();
      const result = await admin.describeConfigs();
      Object.assign(result.resources[0] ?? {}, change);
      admin.describeConfigs.mockResolvedValue(result);
      await expect(storage.capture("samples", async () => offsets)).rejects.toThrow(
        "configuration",
      );
    },
  );

  it("rejects an invalid cluster UUID before native comparison", async () => {
    const { storage, admin, logs } = await fixture();
    const response = await admin.describeCluster();
    response.clusterId = "invalid";
    admin.describeCluster.mockResolvedValue(response);
    await writeFile(join(logs, "meta.properties"), "version=1\ncluster.id=invalid\nnode.id=1\n");
    await expect(storage.capture("samples", async () => offsets)).rejects.toThrow();
  });

  it.each([
    { captured: [] },
    { captured: [{ partition: 1, low: "0", offset: "1" }] },
    { captured: [...offsets, ...offsets] },
  ])("rejects unqualified captured partition sets: %j", async ({ captured }) => {
    const { storage } = await fixture();
    await expect(storage.capture("samples", async () => captured)).rejects.toThrow("partition set");
  });

  it.each(["clusterId", "topicId"] as const)("rejects a mismatched checkpoint %s", async (key) => {
    const { storage, boundaries } = await fixture();
    await expect(
      storage.assertExpired([
        { ...boundaries[0], topic: "samples", offset: "100", [key]: "a".repeat(22) },
      ]),
    ).rejects.toThrow("generation");
    const boundary = {
      topic: "samples",
      partition: 0,
      low: "0",
      offset: "100",
      ...(key === "clusterId" ? { topicId } : { clusterId }),
    };
    await expect(storage.assertExpired([boundary])).rejects.toThrow("generation");
  });

  it.each(["prefix00000000000000000100.log", "00000000000000000100.log.extra"])(
    "rejects a misleading segment filename %s",
    async (name) => {
      const { storage, partition, boundaries } = await fixture();
      await writeFile(join(partition, name), "unknown bytes");
      await expect(
        storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
      ).rejects.toThrow("Unknown Kafka partition file");
    },
  );

  it("rejects directory entries inside the partition", async () => {
    const { storage, partition, boundaries } = await fixture();
    await mkdir(join(partition, "unknown"));
    await expect(
      storage.assertExpired([{ ...boundaries[0], topic: "samples", offset: "100" }]),
    ).rejects.toThrow("file type");
  });

  it("rejects incomplete or duplicated multi-topic checkpoints", async () => {
    const { admin, logs, retired, boundaries, remote } = await fixture();
    const storage = new KafkaLogStorage(
      admin,
      {
        directory: logs,
        brokerDirectory: "/var/lib/kafka/data",
        retiredDirectories: [retired],
        topics: ["samples", "other"],
      },
      remote,
    );
    const boundary = { ...boundaries[0], topic: "samples", offset: "100" };
    for (const entries of [
      [boundary],
      [boundary, boundary],
      [boundary, { ...boundary, topic: "wrong" }],
    ]) {
      await expect(storage.assertExpired(entries)).rejects.toThrow("checkpoints");
    }
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
      entry.configValue = key === "log.dirs" ? "/var/lib/kafka/data,/other" : "false";
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
