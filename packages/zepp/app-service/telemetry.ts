import { log as Logger } from "@zos/utils";
import {
  enqueueTelemetryException,
  restoreBufferedTelemetryEvents,
  serializeBufferedTelemetryEvents,
} from "../src/posthog-client.ts";
import { STORAGE_KEYS } from "../src/storage-keys.ts";

const telemetryLogger = Logger.getLogger("telemetry");

function syncTelemetryBufferStorage(): void {
  const serialized = serializeBufferedTelemetryEvents();
  if (serialized === "[]") {
    settings.settingsStorage.removeItem(STORAGE_KEYS.TELEMETRY_BUFFER);
    return;
  }
  settings.settingsStorage.setItem(STORAGE_KEYS.TELEMETRY_BUFFER, serialized);
}

export function captureException(error: unknown, context: Record<string, unknown> = {}): void {
  telemetryLogger.error("captured exception %j", error);
  enqueueTelemetryException(error, { ...context, source: "zepp-watch" });
  syncTelemetryBufferStorage();
}

export function loadWatchTelemetryBuffer(): void {
  restoreBufferedTelemetryEvents(settings.settingsStorage.getItem(STORAGE_KEYS.TELEMETRY_BUFFER));
}
