import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createProviderDataDeletionRequest,
  findProviderDataDeletionRequest,
  markProviderDataDeletionCompleted,
} from "../db/provider-data-deletion.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "../db/test-helpers.ts";
import { createProviderArtifactStorageTestContext } from "../test-helpers.ts";
import {
  createAccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";

const endpoint = "https://r2.provider-artifact-erasure.test";
const archive = createProviderArtifactStorageTestContext(endpoint);
const userId = randomUUID();
let context: TestContext;

beforeAll(async () => {
  archive.server.listen({ onUnhandledRequest: "error" });
  context = await setupTestDatabase();
  await context.db.execute(
    sql`INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Artifact erasure owner')`,
  );
});
afterAll(async () => {
  archive.server.close();
  archive.client.destroy();
  await context?.cleanup();
});

describe("provider artifact erasure ordering", () => {
  it.each(["fit-file", "garmin-dump", "wahoo"])(
    "finishes an in-flight %s archive write before deleting and acknowledging its provider",
    async (providerId) => {
      const writerPool = createAccountErasureWorkLockPool(context.connectionString);
      const deletionPool = createAccountErasureWorkLockPool(context.connectionString);
      const directory = await mkdtemp(join(tmpdir(), "provider-artifact-erasure-"));
      const filePath = join(directory, "source.fit");
      await writeFile(filePath, "original FIT bytes before parsing");
      const putStarted = createTestBarrier();
      const finishPut = createTestBarrier();
      const events: string[] = [];
      archive.originals.clear();
      archive.server.use(
        http.put(`${endpoint}/imports/*`, async ({ request }) => {
          const bytes = Buffer.from(await request.arrayBuffer());
          const key = new URL(request.url).pathname.slice("/imports/".length);
          events.push("write started");
          putStarted.resolve();
          await finishPut.promise;
          archive.originals.set(key, bytes);
          events.push("write finished");
          return new HttpResponse(null, { headers: { ETag: '"retained"' } });
        }),
        http.get(`${endpoint}/imports`, ({ request }) => {
          events.push("list for deletion");
          const prefix = new URL(request.url).searchParams.get("prefix") ?? "";
          const contents = [...archive.originals.keys()]
            .filter((key) => key.startsWith(prefix))
            .map((key) => `<Contents><Key>${key}</Key></Contents>`)
            .join("");
          return HttpResponse.xml(
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
          );
        }),
        http.post(`${endpoint}/imports`, async ({ request }) => {
          const body = await request.text();
          for (const match of body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
            const key = match[1];
            if (key) archive.originals.delete(key);
          }
          events.push("deleted");
          return HttpResponse.xml(
            '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>',
          );
        }),
      );

      const write = runQueuedUserWorkUnlessAccountErasing(
        writerPool,
        context.db,
        userId,
        "FIT original retention",
        () => archive.storage.retainFile({ userId, providerId, filePath }),
        providerId,
      );
      let deletion: Promise<void> | undefined;
      try {
        await putStarted.promise;
        const request = await createProviderDataDeletionRequest(
          context.db,
          userId,
          providerId,
          randomUUID(),
        );
        deletion = runQueuedUserWorkUnlessAccountErasing(
          deletionPool,
          context.db,
          userId,
          "provider data deletion",
          async () => {
            await archive.storage.deleteForProvider(userId, providerId);
            await markProviderDataDeletionCompleted(context.db, request.eventId);
            events.push("acknowledged");
          },
          providerId,
        );

        await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true));
        expect(events).toEqual(["write started"]);
        expect(
          (await findProviderDataDeletionRequest(context.db, userId, providerId, request.eventId))
            ?.status,
        ).toBe("pending");
        finishPut.resolve();
        await Promise.all([write, deletion]);

        expect(events).toEqual([
          "write started",
          "write finished",
          "list for deletion",
          "deleted",
          "acknowledged",
        ]);
        expect(archive.originals.size).toBe(0);
        expect(
          (await findProviderDataDeletionRequest(context.db, userId, providerId, request.eventId))
            ?.status,
        ).toBe("completed");
      } finally {
        finishPut.resolve();
        await Promise.allSettled([write, deletion]);
        archive.server.resetHandlers();
        await Promise.all([writerPool.close(), deletionPool.close()]);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
