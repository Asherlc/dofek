import { log as Logger } from "@zos/utils";
import { BaseApp } from "@zeppos/zml/base-app";
import { appPlugin } from "@zeppos/zml/3.0/module/messaging/plugin/app";

BaseApp.use(appPlugin);

const logger = Logger.getLogger("imu-logger-app");

App(
  BaseApp({
    globalData: {},
    onCreate() {
      logger.log("app onCreate");
    },
    onDestroy() {
      logger.log("app onDestroy");
    },
  })
);
