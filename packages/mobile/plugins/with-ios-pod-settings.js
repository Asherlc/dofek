/**
 * Expo config plugin that applies Dofek's generated Podfile settings.
 *
 * Dofek's HealthKit and watch targets import Sentry Cocoa directly. Use the
 * source-built CocoaPod so those targets and React Native share one Sentry
 * implementation instead of mixing it with RNSentry's prebuilt XCFramework.
 *
 * Xcode 26+ treats ExpoModulesCore Worklets return-type warnings as errors in
 * EXJavaScriptSerializable.mm. Downgrade that warning until upstream resolves it.
 */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const SENTRY_MARKER = "[with-ios-pod-settings] Use one source-built Sentry Cocoa pod";
const POST_INSTALL_MARKER = "[with-ios-pod-settings] ExpoModulesCore return-type workaround";

const SENTRY_PREAMBLE = [`# ${SENTRY_MARKER}`, "ENV['SENTRY_USE_XCFRAMEWORK'] = '0'", ""].join(
  "\n",
);

const POST_INSTALL_SNIPPET = [
  "",
  `    # ${POST_INSTALL_MARKER}`,
  "    installer.pods_project.targets.each do |target|",
  "      if target.name == 'ExpoModulesCore'",
  "        target.build_configurations.each do |config|",
  "          flags = config.build_settings['OTHER_CPLUSPLUSFLAGS'] || ['$(inherited)']",
  "          flags = [flags] if flags.is_a?(String)",
  "          unless flags.include?('-Wno-error=return-type')",
  "            flags << '-Wno-error=return-type'",
  "          end",
  "          config.build_settings['OTHER_CPLUSPLUSFLAGS'] = flags",
  "        end",
  "      end",
  "    end",
].join("\n");

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withIosPodSettings(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, "Podfile");
      let podfile = fs.readFileSync(podfilePath, "utf-8");

      if (!podfile.includes(SENTRY_MARKER)) {
        podfile = `${SENTRY_PREAMBLE}${podfile}`;
      }

      if (!podfile.includes(POST_INSTALL_MARKER)) {
        const postInstallEndPattern = /(post_install\s+do\s+\|installer\|[\s\S]*?)(^\s*end\s*$)/m;
        if (postInstallEndPattern.test(podfile)) {
          podfile = podfile.replace(postInstallEndPattern, `$1\n${POST_INSTALL_SNIPPET}\n$2`);
        } else {
          podfile += `\n\npost_install do |installer|\n${POST_INSTALL_SNIPPET}\nend\n`;
        }
      }

      fs.writeFileSync(podfilePath, podfile);
      return modConfig;
    },
  ]);
}

module.exports = withIosPodSettings;
