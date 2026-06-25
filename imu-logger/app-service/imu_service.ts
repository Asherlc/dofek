import TransferFile from "@zos/ble/TransferFile";
import { readFileSync } from "@zos/fs";
import { log as Logger } from "@zos/utils";

import { SESSION_FILE, SESSION_META_FILE } from "../src/storage-keys.ts";

const logger = Logger.getLogger("imu-service");

AppService({
  onInit(this: AppServiceContext) {
    logger.log("imu_service onInit");
    this.scheduleTransferPoll();
  },

  onDestroy(this: AppServiceContext) {
    logger.log("imu_service onDestroy");
  },

  scheduleTransferPoll(this: AppServiceContext) {
    logger.log("transfer poll skipped: timers unavailable in App Service");
  },

  transferPendingFile(this: AppServiceContext) {
    try {
      readFileSync({
        path: SESSION_FILE,
        options: { encoding: "binary" },
      });
    } catch {
      logger.log("no session file to transfer");
      return false;
    }

    let meta: Record<string, unknown> = {};
    try {
      const raw = readFileSync({ path: SESSION_META_FILE });
      if (typeof raw === "string") {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          meta = Object.fromEntries(Object.entries(parsed));
        }
      }
    } catch {
      meta = {};
    }

    const transferFile = new TransferFile();
    const outbox = transferFile.getOutbox();
    const task = outbox.enqueueFile(SESSION_FILE, {
      type: "imu-session",
      sampleCount: String(meta.sampleCount ?? 0),
      observedHzX100: String(meta.observedHzX100 ?? 0),
      source: "app-service",
    });

    task.on("change", (event) => {
      logger.log("app-service transfer state %j", event.data);
    });

    return true;
  },
});
