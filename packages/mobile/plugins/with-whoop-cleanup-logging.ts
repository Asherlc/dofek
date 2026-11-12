import { type ConfigPlugin, withAppDelegate } from "expo/config-plugins";

const withWhoopCleanupLogging: ConfigPlugin = (config) =>
  withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("WHOOP cleanup log attribution requires the Swift AppDelegate");
    }
    let contents = modConfig.modResults.contents;
    const hook = "WhoopBleModule.configureCleanupLogAttribution(options)";
    if (contents.includes(hook)) {
      // Sentry's plugin can reinsert its plain call on a subsequent prebuild.
      contents = contents.replace(/^[\t ]*RNSentrySDK\.start\(\)[\t ]*\r?\n/gm, "");
    } else {
      const startup = /^([\t ]*)RNSentrySDK\.start\(\)[\t ]*$/m;
      if (!startup.test(contents)) {
        throw new Error("RNSentrySDK.start() is required before configuring WHOOP cleanup logs");
      }
      contents = contents.replace(
        startup,
        (_call, indent: string) =>
          `${indent}RNSentrySDK.start { options in\n${indent}  ${hook}\n${indent}}`,
      );
      if (!contents.includes("import ExpoWhoopBle")) {
        contents = contents.replace("import RNSentry", "import RNSentry\nimport ExpoWhoopBle");
      }
    }
    modConfig.modResults.contents = contents;
    return modConfig;
  });

export default withWhoopCleanupLogging;
