import { log as Logger } from "@zos/utils";

const telemetryLogger = Logger.getLogger("telemetry");

export function captureException(error: unknown): void {
  telemetryLogger.error("captured exception %j", error);
}
