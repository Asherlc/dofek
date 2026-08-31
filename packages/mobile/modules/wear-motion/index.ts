import type { InertialMeasurementUnitSample } from "@dofek/imu";
import WearMotionModule from "./src/WearMotionModule";

function isSafePendingFileName(fileName: string): boolean {
  return (
    Boolean(fileName) &&
    !fileName.includes("..") &&
    !fileName.includes("/") &&
    !fileName.includes("\\") &&
    fileName === fileName.split(/[/\\]/).pop()
  );
}

function assertSafePendingFileName(fileName: string): void {
  if (!isSafePendingFileName(fileName)) {
    throw new Error(`Invalid pending watch file name: ${fileName}`);
  }
}

/** Lists received Wear OS motion files without consuming them. */
export async function listPendingFiles(): Promise<string[]> {
  return (await WearMotionModule.listPendingFiles()).filter((name: string) =>
    name.startsWith("wear-motion-"),
  );
}

/** Reads a file; callers delete it only after its upload is acknowledged. */
export async function readFile(fileName: string): Promise<InertialMeasurementUnitSample[]> {
  assertSafePendingFileName(fileName);
  return WearMotionModule.readFile(fileName);
}

export function deleteFile(fileName: string): void {
  assertSafePendingFileName(fileName);
  WearMotionModule.deleteFile(fileName);
}
