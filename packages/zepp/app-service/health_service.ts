import { BasePage } from "@zeppos/zml/base-page";
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
import { deliverWatchHealthOutbox } from "../src/watch-health-sync.ts";
import { captureException, ensureWatchInstallId, loadWatchTelemetryBuffer } from "./telemetry.ts";

const logger = Logger.getLogger("health-service");

AppService(
  BasePage({
    state: { syncing: false },
    onInit() {
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
          if (this.state.syncing) {
            return;
          }
          this.state.syncing = true;
          deliverWatchHealthOutbox({
            installId,
            initialOutbox: updatedOutbox,
            request: (envelope) => this.request({ method: "health.upload", params: { envelope } }),
            readLatest: () => readBackgroundHealthOutbox(installId),
            write: writeBackgroundHealthOutbox,
          })
            .catch((error: unknown) => {
              captureException(error, { operation: "background-health-delivery" });
              logger.error("background health delivery failed %j", error);
            })
            .finally(() => {
              this.state.syncing = false;
            });
        } catch (error: unknown) {
          captureException(error, { operation: "collect-and-persist-background-health" });
          logger.error("background health collection failed %j", error);
        }
      });
    },

    onDestroy() {
      logger.log("health_service onDestroy");
    },
  }),
);
