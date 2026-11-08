import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import kafkaJs, { type Admin } from "kafkajs";
import { z } from "zod";
import type { KafkaRemoteStorage } from "./kafka-remote-storage.ts";
import type { AccountErasureRouteHighWatermark } from "./redpanda-drain.ts";

const uuid = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const topicName = z
  .string()
  .min(1)
  .max(249)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
const offset = z.string().regex(/^\d+$/);
const boundarySchema = z.object({
  topic: topicName,
  partition: z.literal(0),
  low: offset,
  offset,
  clusterId: uuid,
  topicId: uuid,
});

interface StorageAdmin {
  describeCluster: Admin["describeCluster"];
  describeConfigs(options: Parameters<Admin["describeConfigs"]>[0]): Promise<unknown>;
  fetchTopicMetadata(options: { topics: string[] }): Promise<{
    topics: Array<{
      name: string;
      partitions: Array<{
        partitionId: number;
        partitionErrorCode: number;
        replicas: number[];
        isr: number[];
        leader: number;
      }>;
    }>;
  }>;
}
const describedConfigs = z.object({
  resources: z.array(
    z.object({
      resourceName: z.string(),
      resourceType: z.number(),
      errorCode: z.number(),
      configEntries: z.array(
        z.object({ configName: z.string(), configValue: z.string().nullable() }),
      ),
    }),
  ),
});
interface StoragePaths {
  directory: string;
  brokerDirectory: string;
  retiredDirectories: readonly string[];
  topics: readonly string[];
}

function properties(contents: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^\s*([^\s:=]+)\s*[:=]\s*(\S+)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || entries.has(match[1])) {
      throw new Error("Malformed Kafka native metadata");
    }
    entries.set(match[1], match[2]);
  }
  return entries;
}

/** Native local and tiered removal for the pinned single broker/log directory. */
export class KafkaLogStorage {
  readonly #admin: StorageAdmin;
  readonly #paths: StoragePaths;
  readonly #remote: Pick<KafkaRemoteStorage, "assertExpired">;
  constructor(
    admin: StorageAdmin,
    paths: StoragePaths,
    remote: Pick<KafkaRemoteStorage, "assertExpired">,
  ) {
    this.#admin = admin;
    this.#paths = paths;
    this.#remote = remote;
  }

  async #context(): Promise<string> {
    const cluster = await this.#admin.describeCluster();
    const broker = cluster.brokers[0];
    if (cluster.brokers.length !== 1 || !broker || cluster.controller !== broker.nodeId) {
      throw new Error("Kafka erasure requires the qualified single broker");
    }
    uuid.parse(cluster.clusterId);
    const configs = describedConfigs.parse(
      await this.#admin.describeConfigs({
        includeSynonyms: false,
        resources: [
          {
            type: kafkaJs.ConfigResourceTypes.BROKER,
            name: String(broker.nodeId),
            configNames: [
              "log.dirs",
              "remote.log.storage.system.enable",
              "remote.log.storage.manager.class.name",
              "remote.log.metadata.manager.class.name",
            ],
          },
        ],
      }),
    );
    const resource = configs.resources.find(
      (entry) =>
        entry.resourceName === String(broker.nodeId) &&
        entry.resourceType === kafkaJs.ConfigResourceTypes.BROKER,
    );
    if (resource?.errorCode !== 0)
      throw new Error("Kafka erasure could not verify broker storage configuration");
    const values = new Map(
      resource.configEntries.map((entry) => [entry.configName, entry.configValue]),
    );
    if (values.get("log.dirs") !== this.#paths.brokerDirectory)
      throw new Error("Kafka log.dirs does not match the qualified storage mount");
    if (values.get("remote.log.storage.system.enable") !== "true")
      throw new Error(
        "Kafka remote.log.storage.system.enable must be true for qualified tiered erasure",
      );
    if (
      values.get("remote.log.storage.manager.class.name") !==
        "io.aiven.kafka.tieredstorage.RemoteStorageManager" ||
      values.get("remote.log.metadata.manager.class.name") !==
        "org.apache.kafka.server.log.remote.metadata.storage.TopicBasedRemoteLogMetadataManager"
    )
      throw new Error("Kafka erasure requires the qualified stock plugin and metadata manager");
    if (!(await lstat(this.#paths.directory)).isDirectory())
      throw new Error("Kafka storage mount must be a directory");
    const native = properties(
      await readFile(join(this.#paths.directory, "meta.properties"), "utf8"),
    );
    if (
      native.get("version") !== "1" ||
      native.get("cluster.id") !== cluster.clusterId ||
      native.get("node.id") !== String(broker.nodeId)
    ) {
      throw new Error("Kafka native cluster/node metadata does not match the active broker");
    }
    return cluster.clusterId;
  }

  async #generation(topic: string, partition: number): Promise<string> {
    topicName.parse(topic);
    if (partition !== 0) throw new Error("Kafka erasure requires the qualified single partition");
    const metadataResponse = await this.#admin.fetchTopicMetadata({ topics: [topic] });
    const partitionMetadata = metadataResponse.topics.find(
      (entry) => entry.name === topic,
    )?.partitions;
    const cluster = await this.#admin.describeCluster();
    const replica = partitionMetadata?.[0];
    if (
      partitionMetadata?.length !== 1 ||
      !replica ||
      replica.partitionId !== 0 ||
      replica.partitionErrorCode !== 0 ||
      replica.replicas.length !== 1 ||
      replica.replicas[0] !== cluster.brokers[0]?.nodeId ||
      replica.leader !== replica.replicas[0] ||
      replica.isr.length !== 1 ||
      replica.isr[0] !== replica.leader
    ) {
      throw new Error("Kafka erasure requires one current in-sync replica per topic");
    }
    const directory = join(this.#paths.directory, `${topic}-${partition}`);
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Kafka partition storage must be a directory");
    const metadata = properties(await readFile(join(directory, "partition.metadata"), "utf8"));
    if (metadata.get("version") !== "0")
      throw new Error("Unsupported Kafka partition metadata version");
    return uuid.parse(metadata.get("topic_id"));
  }

  async capture<T extends { partition: number; low: string; offset: string }>(
    topic: string,
    captureOffsets: () => Promise<T[]>,
  ): Promise<Array<T & { clusterId: string; topicId: string }>> {
    const clusterId = await this.#context();
    const topicId = await this.#generation(topic, 0);
    const offsets = await captureOffsets();
    if (
      offsets.length !== 1 ||
      offsets[0]?.partition !== 0 ||
      (await this.#generation(topic, 0)) !== topicId ||
      (await this.#context()) !== clusterId
    ) {
      throw new Error("Kafka topic generation or partition set changed during capture");
    }
    return offsets.map((entry) => ({ ...entry, clusterId, topicId }));
  }

  async assertExpired(boundaries: readonly AccountErasureRouteHighWatermark[]): Promise<void> {
    const clusterId = await this.#context();
    if (this.#paths.retiredDirectories.length === 0)
      throw new Error("Retired broker storage roots are required");
    for (const directory of this.#paths.retiredDirectories) {
      if (!(await lstat(directory)).isDirectory())
        throw new Error("Retired broker storage mount must be a directory");
      if ((await readdir(directory)).length !== 0)
        throw new Error(
          "Retired broker data remains; account erasure cannot complete before approved retirement",
        );
    }
    if (boundaries.length === 0)
      throw new Error("Kafka erasure generation checkpoints are missing");
    if (
      boundaries.length !== this.#paths.topics.length ||
      new Set(boundaries.map((entry) => entry.topic)).size !== boundaries.length ||
      this.#paths.topics.some((topic) => !boundaries.some((entry) => entry.topic === topic))
    )
      throw new Error("Kafka erasure checkpoints do not cover every configured topic");
    const directories = await readdir(this.#paths.directory, { withFileTypes: true });
    for (const raw of boundaries) {
      if (!("topicId" in raw) || !("clusterId" in raw))
        throw new Error("Kafka erasure generation checkpoint is missing");
      const boundary = boundarySchema.parse(raw);
      if (
        boundary.clusterId !== clusterId ||
        (await this.#generation(boundary.topic, boundary.partition)) !== boundary.topicId
      )
        throw new Error("Kafka checkpoint generation does not match active storage");
      const current = `${boundary.topic}-${boundary.partition}`;
      for (const directory of directories) {
        const prefix = `${boundary.topic}-`;
        if (
          !directory.name.startsWith(prefix) ||
          !/^\d+(?:\..*)?$/.test(directory.name.slice(prefix.length))
        )
          continue;
        if (directory.name !== current)
          throw new Error(`Kafka non-current replica remains for ${boundary.topic}`);
        if (!directory.isDirectory()) throw new Error("Unknown Kafka partition storage entry");
        for (const file of await readdir(join(this.#paths.directory, directory.name), {
          withFileTypes: true,
        })) {
          if (!file.isFile()) throw new Error("Unknown Kafka partition file type");
          if (file.name === "partition.metadata" || file.name === "leader-epoch-checkpoint")
            continue;
          const segment =
            /^(\d{20})\.(?:log|index|timeindex|txnindex|snapshot)(?:\.(?:deleted|swap|cleaned))?$/.exec(
              file.name,
            );
          if (!segment?.[1]) throw new Error(`Unknown Kafka partition file: ${file.name}`);
          if (BigInt(segment[1]) < BigInt(boundary.offset))
            throw new Error(`Kafka retains segment before erasure boundary for ${boundary.topic}`);
        }
      }
      if ((await this.#generation(boundary.topic, boundary.partition)) !== boundary.topicId)
        throw new Error("Kafka topic generation changed during storage verification");
    }
    const segments = await this.#remote.assertExpired(boundaries);
    const cache = join(this.#paths.directory, "remote-log-index-cache");
    if (!(await lstat(cache)).isDirectory())
      throw new Error("Kafka remote index cache mount is invalid");
    for (const file of await readdir(cache, { withFileTypes: true })) {
      const name = /^(\d+)_([A-Za-z0-9_-]{22})\.(?:index|timeindex|txnindex)(?:\.deleted)?$/.exec(
        file.name,
      );
      const segment = name?.[2] ? segments.get(name[2]) : undefined;
      const boundary = boundaries.find(
        (entry) => entry.topic === segment?.topic && entry.topicId === segment?.topicId,
      );
      if (
        !file.isFile() ||
        !name?.[1] ||
        !segment ||
        !boundary ||
        BigInt(name[1]) !== BigInt(segment.startOffset) ||
        BigInt(segment.startOffset) < BigInt(boundary.offset)
      )
        throw new Error("Kafka retains covered or unknown remote index cache files");
    }
    if ((await this.#context()) !== clusterId)
      throw new Error("Kafka cluster generation changed during storage verification");
  }
}
