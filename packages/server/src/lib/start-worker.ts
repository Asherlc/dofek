import { execFile } from "node:child_process";

/**
 * Start the worker container if it's not already running.
 * Uses `docker start` which is a no-op if the container is already running.
 */
export function startWorker(): void {
  execFile("docker", ["start", "dofek-worker"], (err, _stdout, stderr) => {
    if (err) {
      // "No such container" is expected in dev environments without Docker
      const msg = stderr || err.message;
      if (!msg.includes("No such container") && !msg.includes("is already started")) {
        console.error(`[start-worker] Failed to start worker container: ${msg}`);
      }
    }
  });
}
