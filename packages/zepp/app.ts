import { appPlugin } from "@zeppos/zml/3.0/module/messaging/plugin/app";
import { BaseApp } from "@zeppos/zml/base-app";
import { log as Logger } from "@zos/utils";

BaseApp.use(appPlugin);

const logger = Logger.getLogger("dofek-zepp");

App(
  BaseApp({
    globalData: {},
    onCreate() {
      logger.log("app onCreate");
    },
    onDestroy() {
      logger.log("app onDestroy");
    },
  }),
);
