import { BloodOxygen, BodyTemperature, HeartRate, Stress, Time, Workout } from "@zos/sensor";
import { log as Logger } from "@zos/utils";
import {
  appendBackgroundHealthSample,
  collectBackgroundHealthSample,
} from "../src/background-health.ts";
import {
  readBackgroundHealthBuffer,
  writeBackgroundHealthBuffer,
} from "../src/background-health-storage.ts";
import { captureException, loadWatchTelemetryBuffer } from "./telemetry.ts";

const logger = Logger.getLogger("health-service");

AppService({
  onInit(this: AppServiceContext) {
    logger.log("health_service onInit");
    loadWatchTelemetryBuffer();
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
        const currentBuffer = readBackgroundHealthBuffer();
        const updatedBuffer = appendBackgroundHealthSample(currentBuffer, collected);
        writeBackgroundHealthBuffer(updatedBuffer);
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
