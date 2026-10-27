import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createR2Client } from "../src/r2-storage.ts";

const databaseBackupBucket = "dofek-db-backups";
const maximumBackupAgeMilliseconds = 24 * 60 * 60 * 1_000;

interface DatabaseBackupObject {
  key?: string;
  lastModified?: Date;
}

interface ListDatabaseBackupObjectsInput {
  bucket: string;
  continuationToken?: string;
}

export interface ListDatabaseBackupObjectsPage {
  isTruncated?: boolean;
  nextContinuationToken?: string;
  objects: DatabaseBackupObject[];
}

interface DatabaseBackupFreshnessCheckOptions {
  listObjectsPage: (
    input: ListDatabaseBackupObjectsInput,
  ) => Promise<ListDatabaseBackupObjectsPage>;
  now?: Date;
}

interface DatabaseBackupFreshness {
  ageMilliseconds: number;
  key: string;
  lastModified: Date;
}

export async function checkDatabaseBackupFreshness({
  listObjectsPage,
  now = new Date(),
}: DatabaseBackupFreshnessCheckOptions): Promise<DatabaseBackupFreshness> {
  let continuationToken: string | undefined;
  let newestBackup: DatabaseBackupFreshness | undefined;

  while (true) {
    const page = await listObjectsPage({
      bucket: databaseBackupBucket,
      continuationToken,
    });

    for (const object of page.objects) {
      if (!object.key) {
        throw new Error("Database backup object is missing its key");
      }
      if (!object.lastModified || !Number.isFinite(object.lastModified.getTime())) {
        throw new Error(`Database backup object ${object.key} is missing LastModified`);
      }

      if (!newestBackup || object.lastModified > newestBackup.lastModified) {
        newestBackup = {
          ageMilliseconds: now.getTime() - object.lastModified.getTime(),
          key: object.key,
          lastModified: object.lastModified,
        };
      }
    }

    if (!page.isTruncated) {
      break;
    }
    if (!page.nextContinuationToken) {
      throw new Error("R2 returned a truncated backup listing without a continuation token");
    }
    continuationToken = page.nextContinuationToken;
  }

  if (!newestBackup) {
    throw new Error(`No database backups found in R2 bucket ${databaseBackupBucket}`);
  }

  if (newestBackup.ageMilliseconds >= maximumBackupAgeMilliseconds) {
    const ageHours = newestBackup.ageMilliseconds / (60 * 60 * 1_000);
    throw new Error(
      `Newest database backup ${newestBackup.key} is stale: ${ageHours.toFixed(
        2,
      )} hours old; required age is under 24 hours`,
    );
  }

  return newestBackup;
}

export async function main(): Promise<void> {
  const client = createR2Client();
  try {
    const result = await checkDatabaseBackupFreshness({
      listObjectsPage: async ({ bucket, continuationToken }) => {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
          }),
        );

        return {
          isTruncated: response.IsTruncated,
          nextContinuationToken: response.NextContinuationToken,
          objects: (response.Contents ?? []).map((object) => ({
            key: object.Key,
            lastModified: object.LastModified,
          })),
        };
      },
    });
    const ageHours = result.ageMilliseconds / (60 * 60 * 1_000);
    console.log(
      `[database-backup-freshness] ok: ${result.key} was written at ${result.lastModified.toISOString()} (${ageHours.toFixed(
        2,
      )} hours ago)`,
    );
  } finally {
    client.destroy();
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  await main();
}
