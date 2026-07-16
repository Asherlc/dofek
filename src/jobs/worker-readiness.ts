import { createServer, type Server, type ServerResponse } from "node:http";
import * as Sentry from "@sentry/node";
import { logger } from "../logger.ts";

interface WorkerReadinessClient {
  readonly status: string;
  llen(key: string): Promise<unknown>;
}

interface ReadinessWorker {
  readonly name: string;
  readonly client: Promise<WorkerReadinessClient>;
  isRunning(): boolean;
  toKey(type: string): string;
  waitUntilReady(): Promise<{ status: string }>;
}

const WORKER_READINESS_TIMEOUT_MS = 2_500;
const CONNECTION_STATUS_RETRIES = 3;
const CONNECTION_STATUS_RETRY_DELAY_MS = 200;

async function waitForReadyStatus(
  label: string,
  getStatus: () => Promise<{ status: string }>,
): Promise<void> {
  for (let attempt = 0; attempt < CONNECTION_STATUS_RETRIES; attempt++) {
    const connection = await getStatus();
    if (connection.status === "ready") return;
    if (attempt < CONNECTION_STATUS_RETRIES - 1) {
      await new Promise((resolve) => setTimeout(resolve, CONNECTION_STATUS_RETRY_DELAY_MS));
    }
  }
  const connection = await getStatus();
  if (connection.status !== "ready") {
    throw new Error(`BullMQ worker ${label} is not ready`);
  }
}

async function checkWorkerReadiness(workers: readonly ReadinessWorker[]): Promise<void> {
  for (const worker of workers) {
    if (!worker.isRunning()) {
      throw new Error(`BullMQ worker is not running: ${worker.name}`);
    }
  }

  await Promise.all(
    workers.map(async (worker) => {
      await waitForReadyStatus(`blocking connection (${worker.name})`, () =>
        worker.waitUntilReady(),
      );
      await waitForReadyStatus(`command connection (${worker.name})`, () => worker.client);
      const client = await worker.client;
      await client.llen(worker.toKey("wait"));
    }),
  );
}

async function checkWorkerReadinessWithTimeout(readinessCheck: Promise<void>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Worker readiness timed out after ${WORKER_READINESS_TIMEOUT_MS}ms`)),
      WORKER_READINESS_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([readinessCheck, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function sendJson(response: ServerResponse, status: number, body: object) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createWorkerReadinessServer(workers: readonly ReadinessWorker[]): Server {
  let readinessCheck: Promise<void> | null = null;

  function waitUntilReady(): Promise<void> {
    if (readinessCheck) {
      return Promise.reject(new Error("Worker readiness check is already in progress"));
    }
    const currentCheck = checkWorkerReadiness(workers);
    readinessCheck = currentCheck;
    const clearCurrentCheck = () => {
      if (readinessCheck === currentCheck) {
        readinessCheck = null;
      }
    };
    void currentCheck.then(clearCurrentCheck, clearCurrentCheck);
    return checkWorkerReadinessWithTimeout(currentCheck);
  }

  return createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") {
      response.writeHead(404);
      response.end();
      return;
    }

    void waitUntilReady()
      .then(() => sendJson(response, 200, { status: "ok", workers: workers.length }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const isTransient =
          (message.includes("blocking connection") && message.includes("is not ready")) ||
          (message.includes("command connection") && message.includes("is not ready"));
        if (isTransient) {
          logger.warn(`[worker] Readiness check failed: ${message}`);
        } else {
          Sentry.captureException(error);
          logger.error(`[worker] Readiness check failed: ${message}`);
        }
        sendJson(response, 503, { status: "unavailable" });
      });
  });
}
