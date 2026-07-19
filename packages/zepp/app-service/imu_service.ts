import { BloodOxygen, BodyTemperature, HeartRate, Stress, Time, Workout } from "@zos/sensor";
import { log as Logger } from "@zos/utils";
import type { BackgroundHealthBuffer } from "../src/background-health.ts";
import {
  appendBackgroundHealthSample,
  collectBackgroundHealthSample,
} from "../src/background-health.ts";
import {
  readBackgroundHealthBuffer,
  writeBackgroundHealthBuffer,
} from "../src/background-health-storage.ts";

const logger = Logger.getLogger("imu-service");
let backgroundHealthBuffer: BackgroundHealthBuffer;

AppService({
  onInit(this: AppServiceContext) {
    logger.log("imu_service onInit");
    backgroundHealthBuffer = readBackgroundHealthBuffer();
    const time = new Time();
    time.onPerMinute(() => {
      try {
        const collected = collectBackgroundHealthSample({
          HeartRate,
          BloodOxygen,
          BodyTemperature,
          Stress,
          Workout,
        });
        backgroundHealthBuffer = appendBackgroundHealthSample(backgroundHealthBuffer, collected);
        writeBackgroundHealthBuffer(backgroundHealthBuffer);
      } catch (error: unknown) {
        logger.error("background health collection failed %j", error);
      }
    });
  },

  onDestroy(this: AppServiceContext) {
    logger.log("imu_service onDestroy");
  },
});
