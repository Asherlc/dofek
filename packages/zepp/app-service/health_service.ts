import { BloodOxygen, BodyTemperature, HeartRate, Stress, Time, Workout } from "@zos/sensor";
import { log as Logger } from "@zos/utils";
import {
  appendBackgroundHealthEvents,
  collectBackgroundHealthSample,
} from "../src/background-health.ts";
import {
  readBackgroundHealthOutbox,
  writeBackgroundHealthOutbox,
} from "../src/background-health-storage.ts";
import { captureException, ensureWatchInstallId, loadWatchTelemetryBuffer } from "./telemetry.ts";

const logger = Logger.getLogger("health-service");

AppService({
  onInit(this: AppServiceContext) {
    logger.log("health_service onInit");
    loadWatchTelemetryBuffer();
    const installId = ensureWatchInstallId();
    const time = new Time();
    time.onPerMinute(() => {
      try {
        const collected = collectBackgroundHealthSample({
          captureException,
          HeartRate,
          BloodOxygen,
          BodyTemperature,
          Stress,
          Workout,
        });
        const currentOutbox = readBackgroundHealthOutbox(installId);
        const updatedOutbox = appendBackgroundHealthEvents(currentOutbox, collected, installId);
        writeBackgroundHealthOutbox(updatedOutbox);
      } catch (error: unknown) {
        captureException(error, { operation: "collect-and-persist-background-health" });
        logger.error("background health collection failed %j", error);
      }
    });
  },

  onDestroy(this: AppServiceContext) {
    logger.log("health_service onDestroy");
  },
});
