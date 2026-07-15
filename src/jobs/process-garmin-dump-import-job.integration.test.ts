import { createHash, randomUUID } from "node:crypto";
import type { ConnectionOptions, FlowJob, Job } from "bullmq";
import { FlowProducer, Queue, QueueEvents, WaitingChildrenError, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
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
  });

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
