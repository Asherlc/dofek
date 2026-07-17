import { execFile } from "node:child_process";

/**
 * Start a Docker container by name if it's not already running.
 * Uses `docker start`, which may report "is already started" when the container is already running.
 */
function startContainer(containerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("docker", ["start", containerName], (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }

      const message = stderr || error.message;
      if (message.includes("is already started")) {
        resolve();
        return;
      }
      reject(new Error(`[start-worker] Failed to start ${containerName}: ${message}`));
    });
  });
}

/** Start the Node.js BullMQ worker container. */
export function startWorker(): Promise<void> {
  return startContainer("dofek-worker");
}
