import { log as Logger } from "@zos/utils";

const logger = Logger.getLogger("imu-service");

// Zepp OS requires an App Service to keep the process alive while the
// page is not active. This is a minimal anchor — IMU sampling and file
// transfers are driven by the page directly (page/index.ts), not here.
AppService({
  onInit(this: AppServiceContext) {
    logger.log("imu_service onInit");
  },

  onDestroy(this: AppServiceContext) {
    logger.log("imu_service onDestroy");
  },
});
