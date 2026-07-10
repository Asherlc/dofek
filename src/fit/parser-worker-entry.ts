import { parentPort, workerData } from "node:worker_threads";
import { parseFitFile } from "./parser.ts";

if (!parentPort) {
  throw new Error("FIT parser worker requires a parent port");
}

if (!(workerData instanceof Uint8Array)) {
  throw new Error("FIT parser worker requires binary worker data");
}

try {
  const activity = await parseFitFile(Buffer.from(workerData));
  parentPort.postMessage({ status: "ok", activity });
} catch (error) {
  parentPort.postMessage({
    status: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
