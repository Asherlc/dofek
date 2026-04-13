import { execFile } from "node:child_process";

/**
 * Start a Docker container by name if it's not already running.
 * Uses `docker start`, which may report "is already started" when the container is already running.
 */
function startContainer(containerName: string): void {
  execFile("docker", ["start", containerName], (err, _stdout, stderr) => {
    if (err) {
      // "No such container" is expected in dev environments without Docker
      const msg = stderr || err.message;
      if (!msg.includes("No such container") && !msg.includes("is already started")) {
        console.error(`[start-worker] Failed to start ${containerName}: ${msg}`);
      }
    }
  });
}

/** Start the Node.js BullMQ worker container. */
export function startWorker(): void {
  startContainer("dofek-worker");
}

/** Start the Python training export worker container. */
export function startTrainingExportWorker(): void {
  startContainer("dofek-training-export-worker");
}
