import { log as Logger } from "@zos/utils";
import { readFileSync } from "@zos/fs";
import TransferFile from "@zos/ble/TransferFile";

import {
  SESSION_FILE,
  SESSION_META_FILE,
  STORAGE_KEYS,
} from "../utils/storage-keys";

const logger = Logger.getLogger("imu-service");

// App Service restriction (docs): Accelerometer/Gyroscope are unavailable here.
// This service handles durable transfer/retry while the UI page may be inactive.
// IMU sampling always runs in the Device App page, not in App Service.

AppService({
  onInit(param) {
    logger.log("imu_service onInit %s", param);
    this.scheduleTransferPoll();
  },

  onDestroy() {
    logger.log("imu_service onDestroy");
  },

  scheduleTransferPoll() {
    // App Service restriction: setTimeout/setInterval are NOT available.
    // Transfer is triggered by Side Service BLE calls handled through @zos/ble.
    logger.log("transfer poll skipped: timers unavailable in App Service");
  },

  transferPendingFile() {
    try {
      readFileSync({
        path: SESSION_FILE,
        options: { encoding: "binary" },
      });
    } catch (error) {
      logger.log("no session file to transfer");
      return false;
    }

    let meta = {};
    try {
      meta = JSON.parse(
        readFileSync({
          path: SESSION_META_FILE,
        }) || "{}"
      );
    } catch (error) {
      meta = {};
    }

    const transferFile = new TransferFile();
    const outbox = transferFile.getOutbox();
    const task = outbox.enqueueFile(SESSION_FILE, {
      type: "imu-session",
      sampleCount: String(meta.sampleCount || 0),
      observedHzX100: String(meta.observedHzX100 || 0),
      source: "app-service",
    });

    task.on("change", (event) => {
      logger.log("app-service transfer state %j", event.data);
    });

    return true;
  },
});
