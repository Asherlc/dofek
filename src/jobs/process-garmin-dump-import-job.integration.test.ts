import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionOptions, FlowJob, Job } from "bullmq";
import { FlowProducer, Queue, QueueEvents, WaitingChildrenError, Worker } from "bullmq";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { createProviderArtifactStorageTestContext } from "../test-helpers.ts";
import type { LocalImportJobData } from "./local-import-job-data.ts";
import { processFitFileImportBatchJob } from "./process-fit-file-import-batch-job.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";
import { processGarminDumpImportJob } from "./process-garmin-dump-import-job.ts";
import {
  FIT_FILE_IMPORT_BATCH_QUEUE,
  FIT_FILE_IMPORT_QUEUE,
  getRedisConnection,
  IMPORT_QUEUE,
  ZIP_ENTRY_EXTRACT_QUEUE,
} from "./queues.ts";

interface ImportJobData {
  phase: "prepared" | "waiting-children";
}

interface TestJobData {
  runId: string;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Deferred promise resolver was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

function garminFitFlow(runId: string, parent: { id: string; queue: string }): FlowJob {
  const jobHash = createHash("sha256")
    .update(`${runId}\n/job-files/${runId}.zip\nactivity.fit`)
    .digest("hex");
  return {
    name: "fit-file-import-batch",
    queueName: FIT_FILE_IMPORT_BATCH_QUEUE,
    data: { runId },
    opts: {
      jobId: `garmin-dump-fit-batch-${jobHash}`,
      parent,
      ignoreDependencyOnFailure: true,
    },
    children: [
      {
        name: "fit-file-import",
        queueName: FIT_FILE_IMPORT_QUEUE,
        data: { runId },
        opts: {
          jobId: `garmin-dump-fit-${jobHash}`,
          ignoreDependencyOnFailure: true,
        },
        children: [
          {
            name: "zip-entry-extract",
            queueName: ZIP_ENTRY_EXTRACT_QUEUE,
            data: { runId },
            opts: {
              jobId: `garmin-dump-fit-extract-${jobHash}`,
              ignoreDependencyOnFailure: true,
            },
          },
        ],
      },
    ],
  };
}

describe("durable Garmin import waiting-children protocol", () => {
  const queues: Queue[] = [];
  const queueEvents: QueueEvents[] = [];
  const workers: Worker[] = [];
  const flowProducers: FlowProducer[] = [];
  let releaseExtraction: Deferred<void> | undefined;
  const directories: string[] = [];
  const endpoint = "https://r2.garmin-fit-flow.test";
  const archive = createProviderArtifactStorageTestContext(endpoint);
  let context: TestContext;

  beforeAll(async () => {
    archive.server.activate({ onUnhandledRequest: "error" });
    context = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    archive.server.deactivate();
    archive.client.destroy();
    await context?.cleanup();
  });

  afterEach(async () => {
    releaseExtraction?.resolve();
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(queueEvents.map((events) => events.close()));
    await Promise.all(flowProducers.map((producer) => producer.close()));
    await Promise.all(queues.map((queue) => queue.obliterate({ force: true })));
    await Promise.all(queues.map((queue) => queue.close()));
    workers.length = 0;
    queueEvents.length = 0;
    flowProducers.length = 0;
    queues.length = 0;
    releaseExtraction = undefined;
    archive.server.resetHandlers();
    archive.originals.clear();
    archive.writes.length = 0;
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it.each([true, false])(
    "preserves archive ownership through a failed FIT child (archive succeeds: %s)",
    async (archiveSucceeds) => {
      const directory = await mkdtemp(join(tmpdir(), "garmin-fit-flow-"));
      directories.push(directory);
      const bytes = Buffer.from("original malformed FIT bytes");
      const filePath = join(directory, "activity.fit");
      await writeFile(filePath, bytes);
      if (!archiveSucceeds) {
        archive.server.use(
          http.head(`${endpoint}/imports/*`, () => new HttpResponse(null, { status: 503 })),
        );
      }
      const connection = getRedisConnection();
      const runId = randomUUID();
      const queueOptions = { connection, prefix: `garmin-retention-test-${runId}` };
      const importQueue = new Queue<LocalImportJobData>(IMPORT_QUEUE, queueOptions);
      const batchQueue = new Queue(FIT_FILE_IMPORT_BATCH_QUEUE, queueOptions);
      const fitQueue = new Queue(FIT_FILE_IMPORT_QUEUE, queueOptions);
      queues.push(importQueue, batchQueue, fitQueue);
      const events = new QueueEvents(IMPORT_QUEUE, queueOptions);
      queueEvents.push(events);
      await events.waitUntilReady();
      const flow = new FlowProducer(queueOptions);
      flowProducers.push(flow);
      const batchId = `retention-batch-${runId}`;
      const childId = `retention-fit-${runId}`;
      const parent = await importQueue.add("garmin-dump-import", {
        filePath: join(directory, "source.zip"),
        userId: TEST_USER_ID,
        importType: "garmin-dump",
        since: "2026-07-01T00:00:00.000Z",
        checkpoint: {
          version: 1,
          phase: "waiting-children",
          startedAtMs: Date.now(),
          batchId,
          baseResult: { recordsSynced: 0, errors: [] },
          tempDirectories: [directory],
          totalFitFiles: 1,
        },
      });
      if (!parent.id) throw new Error("Expected a durable import job identifier");
      await flow.add({
        name: "fit-file-import-batch",
        queueName: FIT_FILE_IMPORT_BATCH_QUEUE,
        data: { userId: TEST_USER_ID },
        opts: {
          jobId: batchId,
          parent: { id: parent.id, queue: parent.queueQualifiedName },
          ignoreDependencyOnFailure: true,
        },
        children: [
          {
            name: "fit-file-import",
            queueName: FIT_FILE_IMPORT_QUEUE,
            data: {
              filePath,
              originalPath: "activity.fit",
              userId: TEST_USER_ID,
              providerId: "garmin-dump",
            },
            opts: { jobId: childId, ignoreDependencyOnFailure: true },
          },
        ],
      });
      workers.push(
        new Worker(
          FIT_FILE_IMPORT_QUEUE,
          (job) => processFitFileImportJob(job, context.db, undefined, archive.storage),
          queueOptions,
        ),
        new Worker(
          FIT_FILE_IMPORT_BATCH_QUEUE,
          (job) =>
            processFitFileImportBatchJob(
              job,
              async (jobKey) =>
                (await fitQueue.getJob(jobKey.slice(jobKey.lastIndexOf(":") + 1)))?.data,
            ),
          queueOptions,
        ),
        new Worker<LocalImportJobData>(
          IMPORT_QUEUE,
          async (job, token) => {
            if (!job.id || !token) throw new Error("Expected an owned import job lock");
            return processGarminDumpImportJob(
              {
                id: job.id,
                queueQualifiedName: job.queueQualifiedName,
                data: job.data,
                updateData: (data) => job.updateData(data),
                moveToWaitingChildren: () => job.moveToWaitingChildren(token),
                getChildrenValues: () => job.getChildrenValues(),
                getIgnoredChildrenFailures: () => job.getIgnoredChildrenFailures(),
                extendLock: async (duration) => {
                  await job.extendLock(token, duration);
                },
                updateProgress: (progress) => job.updateProgress(progress),
                log: async (message) => {
                  await job.log(message);
                },
              },
              context.db,
            );
          },
          queueOptions,
        ),
      );
      const completion = parent.waitUntilFinished(events, 15_000);
      if (archiveSucceeds) {
        await expect(completion).resolves.toMatchObject({
          recordsSynced: 0,
          errors: [
            expect.objectContaining({ message: expect.stringContaining("FIT file failed") }),
          ],
        });
        const digest = createHash("sha256").update(bytes).digest("hex");
        const objectKey = `provider-artifacts/${TEST_USER_ID}/garmin-dump/${digest}.fit`;
        expect((await fitQueue.getJob(childId))?.data.retainedArtifactKey).toBe(objectKey);
        expect(archive.originals.get(objectKey)).toEqual(bytes);
        await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(completion).rejects.toThrow("Some original FIT files could not be saved");
        expect((await fitQueue.getJob(childId))?.data.retainedArtifactKey).toBeUndefined();
        expect(await readFile(filePath)).toEqual(bytes);
        expect(archive.originals.size).toBe(0);
        expect(await parent.getState()).toBe("failed");
      }
      expect(await (await fitQueue.getJob(childId))?.getState()).toBe("failed");
    },
    30_000,
  );

  it("parks the parent without a lock and resumes once when an identical flow is re-added", async () => {
    const connection: ConnectionOptions = getRedisConnection();
    const runId = randomUUID();
    const prefix = `garmin-recovery-test-${runId}`;
    const queueOptions = { connection, prefix };
    const importQueue = new Queue<ImportJobData>(IMPORT_QUEUE, queueOptions);
    const batchQueue = new Queue<TestJobData>(FIT_FILE_IMPORT_BATCH_QUEUE, queueOptions);
    const fitQueue = new Queue<TestJobData>(FIT_FILE_IMPORT_QUEUE, queueOptions);
    const extractQueue = new Queue<TestJobData>(ZIP_ENTRY_EXTRACT_QUEUE, queueOptions);
    queues.push(importQueue, batchQueue, fitQueue, extractQueue);

    const importEvents = new QueueEvents(IMPORT_QUEUE, queueOptions);
    queueEvents.push(importEvents);
    const flowProducer = new FlowProducer(queueOptions);
    flowProducers.push(flowProducer);

    const parentParked = deferred<{ job: Job<ImportJobData>; token: string }>();
    const extractionStarted = deferred<void>();
    const extractionRelease = deferred<void>();
    releaseExtraction = extractionRelease;
    const runCounts = { parent: 0, batch: 0, fit: 0, extract: 0 };

    const processImport = async (job: Job<ImportJobData>, token?: string) => {
      runCounts.parent += 1;
      if (!token) {
        throw new Error("BullMQ did not provide an import job lock token");
      }

      if (job.data.phase === "prepared") {
        if (!job.id) {
          throw new Error("BullMQ did not provide an import job ID");
        }
        await flowProducer.add(garminFitFlow(runId, { id: job.id, queue: job.queueQualifiedName }));
        await job.updateData({ phase: "waiting-children" });
      }

      const movedToWaitingChildren = await job.moveToWaitingChildren(token);
      if (movedToWaitingChildren) {
        parentParked.resolve({ job, token });
        throw new WaitingChildrenError();
      }

      return { runId };
    };
    const importWorker = new Worker<ImportJobData>(IMPORT_QUEUE, processImport, queueOptions);
    const batchWorker = new Worker<TestJobData>(
      FIT_FILE_IMPORT_BATCH_QUEUE,
      async () => {
        runCounts.batch += 1;
        return { runId };
      },
      queueOptions,
    );
    const fitWorker = new Worker<TestJobData>(
      FIT_FILE_IMPORT_QUEUE,
      async () => {
        runCounts.fit += 1;
        return { runId };
      },
      queueOptions,
    );
    const extractWorker = new Worker<TestJobData>(
      ZIP_ENTRY_EXTRACT_QUEUE,
      async () => {
        runCounts.extract += 1;
        extractionStarted.resolve();
        await extractionRelease.promise;
        return { runId };
      },
      queueOptions,
    );
    workers.push(importWorker, batchWorker, fitWorker, extractWorker);

    await Promise.all([
      importEvents.waitUntilReady(),
      flowProducer.waitUntilReady(),
      ...workers.map((worker) => worker.waitUntilReady()),
    ]);

    const parentJobId = `garmin-import-${runId}`;
    const parentJob = await importQueue.add(
      "garmin-dump-import",
      { phase: "prepared" },
      { jobId: parentJobId },
    );
    const parentCompletion = parentJob.waitUntilFinished(importEvents, 15_000);
    const parkedParent = await parentParked.promise;
    await extractionStarted.promise;

    expect(await parentJob.getState()).toBe("waiting-children");
    expect(await parkedParent.job.extendLock(parkedParent.token, 30_000)).toBe(0);

    await importWorker.close();
    workers.splice(workers.indexOf(importWorker), 1);
    const replacementImportWorker = new Worker<ImportJobData>(
      IMPORT_QUEUE,
      processImport,
      queueOptions,
    );
    workers.push(replacementImportWorker);
    await replacementImportWorker.waitUntilReady();

    const deterministicFlow = garminFitFlow(runId, {
      id: parentJobId,
      queue: parentJob.queueQualifiedName,
    });
    await flowProducer.add(deterministicFlow);
    await flowProducer.add(deterministicFlow);

    const expectedJobHash = createHash("sha256")
      .update(`${runId}\n/job-files/${runId}.zip\nactivity.fit`)
      .digest("hex");
    const batchJob = await batchQueue.getJob(`garmin-dump-fit-batch-${expectedJobHash}`);
    expect(batchJob?.id).toBe(`garmin-dump-fit-batch-${expectedJobHash}`);
    expect(batchJob?.parentKey).toBe(`${parentJob.queueQualifiedName}:${parentJobId}`);
    expect(batchJob?.parent).toEqual(
      expect.objectContaining({ id: parentJobId, queueKey: parentJob.queueQualifiedName }),
    );
    expect(await fitQueue.getJob(`garmin-dump-fit-${expectedJobHash}`)).not.toBeUndefined();
    expect(
      await extractQueue.getJob(`garmin-dump-fit-extract-${expectedJobHash}`),
    ).not.toBeUndefined();

    extractionRelease.resolve();
    await expect(parentCompletion).resolves.toEqual({ runId });
    expect(runCounts).toEqual({ parent: 2, batch: 1, fit: 1, extract: 1 });
  });
});
