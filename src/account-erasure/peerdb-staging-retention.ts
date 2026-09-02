import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";

const RETENTION_RULE_ID = "peerdb-transient-stage-retention";
const MAX_RETENTION_DAYS = 1;
const MAX_LIST_PAGES = 10_000;

interface PeerDbLifecycleRule {
  expirationDays: number | null;
  filter: {
    hasAnd: boolean;
    hasTag: boolean;
    objectSizeGreaterThan: number | null;
    objectSizeLessThan: number | null;
    prefix: string | null;
  };
  id: string | null;
  legacyPrefix: string | null;
  status: string | null;
}

export interface PeerDbStagingObject {
  eTag: string | null;
  key: string | null;
  lastModified: Date | null;
}

export interface PeerDbStagingMultipartUpload {
  initiated: Date | null;
  key: string | null;
  uploadId: string | null;
}

export interface PeerDbStagingStorage {
  createBoundaryMarker(key: string): Promise<{
    eTag: string;
    lastModified: Date;
  }>;
  getLifecycleConfiguration(): Promise<{
    rules: PeerDbLifecycleRule[];
  }>;
  getVersioningStatus(): Promise<string | null>;
  listMultipartUploads(
    keyMarker: string | null,
    uploadIdMarker: string | null,
  ): Promise<{
    isTruncated: boolean;
    nextKeyMarker: string | null;
    nextUploadIdMarker: string | null;
    uploads: PeerDbStagingMultipartUpload[];
  }>;
  listObjects(continuationToken: string | null): Promise<{
    isTruncated: boolean;
    nextContinuationToken: string | null;
    objects: PeerDbStagingObject[];
  }>;
}

export interface PeerDbStagingRetentionResult {
  lifecycleRetentionDays: number;
  multipartUploadsInspected: number;
  objectsInspected: number;
  verified: true;
}

interface PeerDbStagingObjectCursor {
  continuationToken: string | null;
  isTruncated: boolean;
  nextContinuationToken: string | null;
}

interface PeerDbStagingMultipartCursor {
  isTruncated: boolean;
  keyMarker: string | null;
  nextKeyMarker: string | null;
  nextUploadIdMarker: string | null;
  uploadIdMarker: string | null;
}

export interface PeerDbStagingInventory {
  latestStorageTimestamp: Date | null;
  multipartCursors: readonly PeerDbStagingMultipartCursor[];
  multipartUploads: readonly {
    initiated: Date;
    key: string;
    uploadId: string;
  }[];
  objectCursors: readonly PeerDbStagingObjectCursor[];
  objects: readonly {
    eTag: string;
    key: string;
    lastModified: Date;
  }[];
}

function requiredDate(date: Date | null, stateKind: "multipart uploads" | "objects"): Date {
  if (!date || !Number.isFinite(date.getTime())) {
    throw new Error(`PeerDB staging ${stateKind} are missing required timestamps`);
  }
  return date;
}

function requiredString(
  value: string | null,
  stateKind: "multipart uploads" | "objects",
  field: string,
): string {
  if (!value) {
    throw new Error(`PeerDB staging ${stateKind} are missing required ${field}`);
  }
  return value;
}

function assertLifecycleConfiguration(
  lifecycle: Awaited<ReturnType<PeerDbStagingStorage["getLifecycleConfiguration"]>>,
): number {
  const rule = lifecycle.rules.find((candidate) => candidate.id === RETENTION_RULE_ID);
  if (
    rule?.status !== "Enabled" ||
    rule.expirationDays !== MAX_RETENTION_DAYS ||
    rule.filter.prefix !== "" ||
    rule.filter.hasAnd ||
    rule.filter.hasTag ||
    rule.filter.objectSizeGreaterThan !== null ||
    rule.filter.objectSizeLessThan !== null ||
    rule.legacyPrefix !== null
  ) {
    throw new Error("PeerDB staging bucket is missing the required global one-day lifecycle rule");
  }
  return rule.expirationDays;
}

async function listObjects(
  storage: PeerDbStagingStorage,
): Promise<Pick<PeerDbStagingInventory, "objectCursors" | "objects">> {
  let continuationToken: string | null = null;
  const seenContinuationTokens = new Set<string>();
  const objectCursors: PeerDbStagingObjectCursor[] = [];
  const objects: {
    eTag: string;
    key: string;
    lastModified: Date;
  }[] = [];
  const seenObjectKeys = new Set<string>();
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await storage.listObjects(continuationToken);
    objectCursors.push({
      continuationToken,
      isTruncated: result.isTruncated,
      nextContinuationToken: result.nextContinuationToken,
    });
    for (const object of result.objects) {
      const key = requiredString(object.key, "objects", "keys");
      if (seenObjectKeys.has(key)) {
        throw new Error(`PeerDB staging object listing returned duplicate key ${key}`);
      }
      seenObjectKeys.add(key);
      objects.push({
        eTag: requiredString(object.eTag, "objects", "ETags"),
        key,
        lastModified: requiredDate(object.lastModified, "objects"),
      });
    }
    if (!result.isTruncated) {
      objects.sort((first, second) => first.key.localeCompare(second.key));
      return { objectCursors, objects };
    }
    if (!result.nextContinuationToken) {
      throw new Error("PeerDB staging object listing was truncated without a continuation token");
    }
    if (seenContinuationTokens.has(result.nextContinuationToken)) {
      throw new Error("PeerDB staging object listing repeated a continuation token");
    }
    seenContinuationTokens.add(result.nextContinuationToken);
    continuationToken = result.nextContinuationToken;
  }
  throw new Error("PeerDB staging object listing did not converge");
}

async function listMultipartUploads(
  storage: PeerDbStagingStorage,
): Promise<Pick<PeerDbStagingInventory, "multipartCursors" | "multipartUploads">> {
  let keyMarker: string | null = null;
  let uploadIdMarker: string | null = null;
  const seenMarkerPairs = new Set<string>();
  const multipartCursors: PeerDbStagingMultipartCursor[] = [];
  const multipartUploads: {
    initiated: Date;
    key: string;
    uploadId: string;
  }[] = [];
  const seenUploads = new Set<string>();
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await storage.listMultipartUploads(keyMarker, uploadIdMarker);
    multipartCursors.push({
      isTruncated: result.isTruncated,
      keyMarker,
      nextKeyMarker: result.nextKeyMarker,
      nextUploadIdMarker: result.nextUploadIdMarker,
      uploadIdMarker,
    });
    for (const upload of result.uploads) {
      const key = requiredString(upload.key, "multipart uploads", "keys");
      const uploadId = requiredString(upload.uploadId, "multipart uploads", "upload IDs");
      const uploadIdentity = `${key}\0${uploadId}`;
      if (seenUploads.has(uploadIdentity)) {
        throw new Error(
          `PeerDB staging multipart listing returned duplicate upload ${key}/${uploadId}`,
        );
      }
      seenUploads.add(uploadIdentity);
      multipartUploads.push({
        initiated: requiredDate(upload.initiated, "multipart uploads"),
        key,
        uploadId,
      });
    }
    if (!result.isTruncated) {
      multipartUploads.sort((first, second) => {
        const keyOrder = first.key.localeCompare(second.key);
        return keyOrder === 0 ? first.uploadId.localeCompare(second.uploadId) : keyOrder;
      });
      return { multipartCursors, multipartUploads };
    }
    if (!result.nextKeyMarker || !result.nextUploadIdMarker) {
      throw new Error(
        "PeerDB staging multipart listing was truncated without continuation markers",
      );
    }
    const markerPair = `${result.nextKeyMarker}\0${result.nextUploadIdMarker}`;
    if (seenMarkerPairs.has(markerPair)) {
      throw new Error("PeerDB staging multipart listing repeated continuation markers");
    }
    seenMarkerPairs.add(markerPair);
    keyMarker = result.nextKeyMarker;
    uploadIdMarker = result.nextUploadIdMarker;
  }
  throw new Error("PeerDB staging multipart listing did not converge");
}

function latestStorageTimestamp(
  objects: PeerDbStagingInventory["objects"],
  multipartUploads: PeerDbStagingInventory["multipartUploads"],
): Date | null {
  let latestTimestamp: Date | null = null;
  for (const timestamp of [
    ...objects.map((object) => object.lastModified),
    ...multipartUploads.map((upload) => upload.initiated),
  ]) {
    if (!latestTimestamp || timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }
  return latestTimestamp;
}

export async function capturePeerDbStagingInventory(
  storage: PeerDbStagingStorage,
): Promise<PeerDbStagingInventory> {
  const [objectInventory, multipartInventory] = await Promise.all([
    listObjects(storage),
    listMultipartUploads(storage),
  ]);
  return {
    latestStorageTimestamp: latestStorageTimestamp(
      objectInventory.objects,
      multipartInventory.multipartUploads,
    ),
    ...multipartInventory,
    ...objectInventory,
  };
}

function datesEqual(first: Date | null, second: Date | null): boolean {
  return first?.getTime() === second?.getTime();
}

export function peerDbStagingInventoriesEqual(
  first: PeerDbStagingInventory,
  second: PeerDbStagingInventory,
): boolean {
  return (
    datesEqual(first.latestStorageTimestamp, second.latestStorageTimestamp) &&
    JSON.stringify(first.objectCursors) === JSON.stringify(second.objectCursors) &&
    JSON.stringify(first.multipartCursors) === JSON.stringify(second.multipartCursors) &&
    first.objects.length === second.objects.length &&
    first.objects.every((object, index) => {
      const other = second.objects[index];
      return (
        other !== undefined &&
        object.eTag === other.eTag &&
        object.key === other.key &&
        object.lastModified.getTime() === other.lastModified.getTime()
      );
    }) &&
    first.multipartUploads.length === second.multipartUploads.length &&
    first.multipartUploads.every((upload, index) => {
      const other = second.multipartUploads[index];
      return (
        other !== undefined &&
        upload.initiated.getTime() === other.initiated.getTime() &&
        upload.key === other.key &&
        upload.uploadId === other.uploadId
      );
    })
  );
}

export async function verifyPeerDbStagingRetention(
  storage: PeerDbStagingStorage,
  input: { cutoff: Date; now: Date },
): Promise<PeerDbStagingRetentionResult> {
  const accountErasureCutoff = z.date().parse(input.cutoff);
  const now = z.date().parse(input.now);
  const lifecycleRetentionDays = assertLifecycleConfiguration(
    await storage.getLifecycleConfiguration(),
  );
  if ((await storage.getVersioningStatus()) !== null) {
    throw new Error("PeerDB staging bucket versioning must be disabled for account-erasure proof");
  }
  const lifecycleBoundary = new Date(now.getTime() - MAX_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const inventory = await capturePeerDbStagingInventory(storage);
  for (const object of inventory.objects) {
    if (object.lastModified <= accountErasureCutoff) {
      throw new Error(
        "PeerDB staging bucket still contains an object from at or before the account-erasure cutoff",
      );
    }
    if (object.lastModified <= lifecycleBoundary) {
      throw new Error(
        "PeerDB staging bucket still contains objects past the one-day lifecycle boundary",
      );
    }
  }
  for (const upload of inventory.multipartUploads) {
    if (upload.initiated <= accountErasureCutoff) {
      throw new Error(
        "PeerDB staging bucket still contains a multipart upload from at or before the account-erasure cutoff",
      );
    }
    if (upload.initiated <= lifecycleBoundary) {
      throw new Error(
        "PeerDB staging bucket still contains multipart uploads past the one-day lifecycle boundary",
      );
    }
  }
  return {
    lifecycleRetentionDays,
    multipartUploadsInspected: inventory.multipartUploads.length,
    objectsInspected: inventory.objects.length,
    verified: true,
  };
}

export class S3PeerDbStagingStorage implements PeerDbStagingStorage {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = z.string().trim().min(1).parse(bucket);
  }

  async createBoundaryMarker(key: string): Promise<{
    eTag: string;
    lastModified: Date;
  }> {
    const markerKey = z.string().trim().min(1).parse(key);
    const putResult = await this.#client.send(
      new PutObjectCommand({
        Body: new Uint8Array(0),
        Bucket: this.#bucket,
        ContentLength: 0,
        Key: markerKey,
      }),
    );
    if (!putResult.ETag) {
      throw new Error("PeerDB staging boundary marker PUT did not return an ETag");
    }
    const headResult = await this.#client.send(
      new HeadObjectCommand({
        Bucket: this.#bucket,
        Key: markerKey,
      }),
    );
    if (!headResult.ETag || headResult.ETag !== putResult.ETag) {
      throw new Error("PeerDB staging boundary marker changed between PUT and HEAD");
    }
    if (
      !headResult.LastModified ||
      !Number.isFinite(headResult.LastModified.getTime()) ||
      headResult.ContentLength !== 0
    ) {
      throw new Error("PeerDB staging boundary marker HEAD returned invalid object evidence");
    }
    return {
      eTag: headResult.ETag,
      lastModified: headResult.LastModified,
    };
  }

  async getLifecycleConfiguration(): Promise<{
    rules: PeerDbLifecycleRule[];
  }> {
    const output = await this.#client.send(
      new GetBucketLifecycleConfigurationCommand({
        Bucket: this.#bucket,
      }),
    );
    return {
      rules: (output.Rules ?? []).map((rule) => ({
        expirationDays: rule.Expiration?.Days ?? null,
        filter: {
          hasAnd: rule.Filter?.And !== undefined,
          hasTag: rule.Filter?.Tag !== undefined,
          objectSizeGreaterThan: rule.Filter?.ObjectSizeGreaterThan ?? null,
          objectSizeLessThan: rule.Filter?.ObjectSizeLessThan ?? null,
          prefix: rule.Filter?.Prefix ?? null,
        },
        id: rule.ID ?? null,
        legacyPrefix: rule.Prefix ?? null,
        status: rule.Status ?? null,
      })),
    };
  }

  async getVersioningStatus(): Promise<string | null> {
    const output = await this.#client.send(
      new GetBucketVersioningCommand({ Bucket: this.#bucket }),
    );
    return output.Status ?? null;
  }

  async listMultipartUploads(
    keyMarker: string | null,
    uploadIdMarker: string | null,
  ): Promise<{
    isTruncated: boolean;
    nextKeyMarker: string | null;
    nextUploadIdMarker: string | null;
    uploads: PeerDbStagingMultipartUpload[];
  }> {
    const output = await this.#client.send(
      new ListMultipartUploadsCommand({
        Bucket: this.#bucket,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {}),
      }),
    );
    return {
      isTruncated: output.IsTruncated ?? false,
      nextKeyMarker: output.NextKeyMarker ?? null,
      nextUploadIdMarker: output.NextUploadIdMarker ?? null,
      uploads: (output.Uploads ?? []).map((upload) => ({
        initiated: upload.Initiated ?? null,
        key: upload.Key ?? null,
        uploadId: upload.UploadId ?? null,
      })),
    };
  }

  async listObjects(continuationToken: string | null): Promise<{
    isTruncated: boolean;
    nextContinuationToken: string | null;
    objects: PeerDbStagingObject[];
  }> {
    const output = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    return {
      isTruncated: output.IsTruncated ?? false,
      nextContinuationToken: output.NextContinuationToken ?? null,
      objects: (output.Contents ?? []).map((object) => ({
        eTag: object.ETag ?? null,
        key: object.Key ?? null,
        lastModified: object.LastModified ?? null,
      })),
    };
  }
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function createPeerDbStagingStorageFromEnv(): {
  close(): void;
  storage: S3PeerDbStagingStorage;
} {
  const client = new S3Client({
    credentials: {
      accessKeyId: process.env.PEERDB_STAGE_S3_ACCESS_KEY_ID ?? "peerdb",
      secretAccessKey: requiredEnvironmentVariable("POSTGRES_PASSWORD"),
    },
    endpoint: process.env.PEERDB_STAGE_S3_ENDPOINT ?? "http://peerdb-minio:9000",
    forcePathStyle: true,
    region: "us-east-1",
  });
  return {
    close: () => client.destroy(),
    storage: new S3PeerDbStagingStorage(
      client,
      process.env.PEERDB_STAGE_S3_BUCKET ?? "peerdbbucket",
    ),
  };
}
