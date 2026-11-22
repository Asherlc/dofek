import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { createR2Client, requiredR2EnvironmentVariable } from "../src/r2-storage.ts";

// Databasus encrypted-backup layout, from
// https://databasus.com/how-to-recover-without-databasus (the page marks itself outdated, so the
// decrypted output is verified by pg_restore): 64-byte header starting with "PGRSUS01", then
// records of a 4-byte big-endian length followed by AES-256-GCM ciphertext and a 16-byte tag.
// Key: PBKDF2-HMAC-SHA256(masterKey + backupId, salt, 100000 iterations, 32 bytes). Nonce: the
// metadata IV with bytes 4..11 replaced by the big-endian chunk index.
const bucket = "dofek-db-backups";
const headerLength = 64;
const magic = "PGRSUS01";
const tagLength = 16;

const metadataSchema = z.object({
  backupId: z.string().min(1),
  encryption: z.string(),
  encryptionIV: z.string().min(1),
  encryptionSalt: z.string().min(1),
});

async function findNewestBackupKey(client: S3Client): Promise<string> {
  let newest: { key: string; lastModified: Date } | undefined;
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key || !object.LastModified || object.Key.endsWith(".metadata")) continue;
      if (!newest || object.LastModified > newest.lastModified) {
        newest = { key: object.Key, lastModified: object.LastModified };
      }
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  if (!newest) throw new Error(`No database backups found in R2 bucket ${bucket}`);
  return newest.key;
}

async function downloadObject(client: S3Client, key: string, path: string): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body || !("pipe" in response.Body)) {
    throw new Error(`R2 object ${key} has no readable body`);
  }
  await pipeline(response.Body, createWriteStream(path));
}

async function readMetadata(client: S3Client, key: string) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: `${key}.metadata` }),
  );
  const text = await response.Body?.transformToString();
  if (!text) throw new Error(`R2 object ${key}.metadata is empty`);
  return metadataSchema.parse(JSON.parse(text));
}

async function decryptBackup(
  encryptedPath: string,
  decryptedPath: string,
  masterKey: string,
  metadata: z.infer<typeof metadataSchema>,
): Promise<void> {
  const key = pbkdf2Sync(
    masterKey + metadata.backupId,
    Buffer.from(metadata.encryptionSalt, "base64"),
    100_000,
    32,
    "sha256",
  );
  const baseNonce = Buffer.from(metadata.encryptionIV, "base64");
  if (baseNonce.length !== 12) throw new Error("Expected a 12-byte backup nonce");
  const input = await open(encryptedPath, "r");
  const output = createWriteStream(decryptedPath);
  try {
    const header = Buffer.alloc(headerLength);
    await input.read(header, 0, headerLength, 0);
    if (header.subarray(0, magic.length).toString("ascii") !== magic) {
      throw new Error("Backup does not start with the expected PGRSUS01 header");
    }
    let position = headerLength;
    for (let index = 0n; ; index += 1n) {
      const lengthBuffer = Buffer.alloc(4);
      const { bytesRead } = await input.read(lengthBuffer, 0, 4, position);
      if (bytesRead === 0) break;
      const length = lengthBuffer.readUInt32BE(0);
      const record = Buffer.alloc(length);
      await input.read(record, 0, length, position + 4);
      position += 4 + length;
      const nonce = Buffer.from(baseNonce);
      nonce.writeBigUInt64BE(index, 4);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAuthTag(record.subarray(length - tagLength));
      const plaintext = Buffer.concat([
        decipher.update(record.subarray(0, length - tagLength)),
        decipher.final(),
      ]);
      if (!output.write(plaintext)) await new Promise((done) => output.once("drain", done));
    }
  } finally {
    await input.close();
    await new Promise<void>((done) => output.end(done));
  }
}

/** Downloads and decrypts the newest Databasus backup. Returns the decrypted dump path. */
export async function downloadLatestDatabaseBackup(directory: string): Promise<string> {
  const masterKey = requiredR2EnvironmentVariable("DATABASUS_SECRET_KEY").trim();
  const client = createR2Client();
  try {
    const key = await findNewestBackupKey(client);
    const metadata = await readMetadata(client, key);
    if (metadata.encryption.toUpperCase() !== "ENCRYPTED") {
      throw new Error(`Unsupported backup encryption mode: ${metadata.encryption}`);
    }
    const encryptedPath = join(directory, "backup.encrypted");
    const decryptedPath = join(directory, "backup.dump");
    await downloadObject(client, key, encryptedPath);
    await decryptBackup(encryptedPath, decryptedPath, masterKey, metadata);
    console.error(`[backup] decrypted ${key}`);
    return decryptedPath;
  } finally {
    client.destroy();
  }
}
