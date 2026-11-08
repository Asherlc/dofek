import {
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { AccountErasureRouteHighWatermark } from "./redpanda-drain.ts";

export interface KafkaRemoteSegment {
  topic: string;
  topicId: string;
  startOffset: string;
}

/** Observed absence, with the explicitly accepted unknown-outcome PUT exception. */
export class KafkaRemoteStorage {
  readonly #client: Pick<S3Client, "send">;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #assertNativeDeleted: (
    boundaries: readonly AccountErasureRouteHighWatermark[],
  ) => Promise<Map<string, KafkaRemoteSegment>>;
  constructor(
    client: Pick<S3Client, "send">,
    bucket: string,
    prefix: string,
    assertNativeDeleted: (
      boundaries: readonly AccountErasureRouteHighWatermark[],
    ) => Promise<Map<string, KafkaRemoteSegment>>,
  ) {
    if (!bucket || !prefix.endsWith("/") || prefix.startsWith("/"))
      throw new Error("Kafka tiered bucket and explicit generation prefix are required");
    this.#client = client;
    this.#bucket = bucket;
    this.#prefix = prefix;
    this.#assertNativeDeleted = assertNativeDeleted;
  }

  async assertExpired(boundaries: readonly AccountErasureRouteHighWatermark[]) {
    if (boundaries.some((boundary) => `${boundary.clusterId}/` !== this.#prefix))
      throw new Error("Kafka tiered prefix does not match checkpoint cluster generation");
    const segments = await this.#assertNativeDeleted(boundaries);
    const inspect = (key: string | undefined) => {
      if (!key?.startsWith(this.#prefix)) throw new Error("Unknown Kafka tiered object key");
      const native =
        /^(.*)-([A-Za-z0-9_-]{22})\/(\d+)\/(\d{20})-([A-Za-z0-9_-]{22})\.(?:log|indexes|rsm-manifest)$/.exec(
          key.slice(this.#prefix.length),
        );
      const boundary = boundaries.find(
        (entry) =>
          entry.topic === native?.[1] &&
          entry.topicId === native?.[2] &&
          String(entry.partition) === native?.[3],
      );
      if (!boundary || !native?.[4])
        throw new Error("Unknown Kafka tiered object generation/layout");
      if (BigInt(native[4]) < BigInt(boundary.offset))
        throw new Error(
          `Kafka tiered storage retains covered data or upload for ${boundary.topic}`,
        );
    };
    let token: string | undefined;
    const tokens = new Set<string>();
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#prefix,
          ContinuationToken: token,
        }),
      );
      if (typeof page.IsTruncated !== "boolean")
        throw new Error("Incomplete Kafka tiered object pagination");
      for (const object of page.Contents ?? []) inspect(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!token || tokens.has(token) || tokens.size >= 10_000))
        throw new Error("Incomplete Kafka tiered object pagination");
      if (token) tokens.add(token);
    } while (token);
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    const markers = new Set<string>();
    let more: boolean;
    do {
      const page = await this.#client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.#bucket,
          Prefix: this.#prefix,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      if (typeof page.IsTruncated !== "boolean")
        throw new Error("Incomplete Kafka tiered multipart pagination");
      for (const upload of page.Uploads ?? []) inspect(upload.Key);
      more = page.IsTruncated === true;
      keyMarker = page.NextKeyMarker;
      uploadIdMarker = page.NextUploadIdMarker;
      const marker = JSON.stringify([keyMarker, uploadIdMarker]);
      if (more && (!keyMarker || !uploadIdMarker || markers.has(marker) || markers.size >= 10_000))
        throw new Error("Incomplete Kafka tiered multipart pagination");
      markers.add(marker);
    } while (more);
    return segments;
  }
}
