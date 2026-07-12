import { parentPort, workerData } from "node:worker_threads";
import { parseFitFile } from "./parser.ts";

function isBinaryWorkerData(value: unknown): value is NodeJS.ArrayBufferView {
  return ArrayBuffer.isView(value);
}

async function runFitParserWorker(): Promise<void> {
  if (!parentPort) {
    throw new Error("FIT parser worker requires a parent port");
  }

  try {
    if (!isBinaryWorkerData(workerData)) {
      throw new Error("FIT parser worker requires binary worker data");
    }

    const data = Buffer.from(workerData.buffer, workerData.byteOffset, workerData.byteLength);
    const activity = await parseFitFile(data);
    parentPort.postMessage({ status: "ok", activity });
  } catch (error) {
    parentPort.postMessage({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

void runFitParserWorker();
