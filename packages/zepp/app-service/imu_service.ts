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

const logger = Logger.getLogger("imu-service");

AppService({
  onInit(this: AppServiceContext) {
    logger.log("imu_service onInit");
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
        captureException(error);
        logger.error("background health collection failed %j", error);
      }
    });
  },

  onDestroy(this: AppServiceContext) {
    logger.log("imu_service onDestroy");
  },
});
