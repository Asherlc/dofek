import { log as Logger } from "@zos/utils";
import {
  captureException as reportException,
  enqueueTelemetryException,
  restoreBufferedTelemetryEvents,
  serializeBufferedTelemetryEvents,
} from "../src/posthog-client.ts";
import { STORAGE_KEYS } from "../src/storage-keys.ts";

const telemetryLogger = Logger.getLogger("telemetry");

function persistBufferedTelemetry(): void {
  settings.settingsStorage.setItem(
    STORAGE_KEYS.TELEMETRY_BUFFER,
    serializeBufferedTelemetryEvents(),
  );
}

export function captureException(error: unknown, context: Record<string, unknown> = {}): void {
  telemetryLogger.error("captured exception %j", error);
  enqueueTelemetryException(error, { ...context, source: "zepp-watch" });
  persistBufferedTelemetry();
  void reportException(error, { ...context, source: "zepp-watch" });
}

export function loadWatchTelemetryBuffer(): void {
  restoreBufferedTelemetryEvents(settings.settingsStorage.getItem(STORAGE_KEYS.TELEMETRY_BUFFER));
}
