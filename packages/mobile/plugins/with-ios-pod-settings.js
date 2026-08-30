/**
 * Expo config plugin that applies Dofek's generated Podfile settings.
 *
 * Xcode 26+ treats ExpoModulesCore Worklets return-type warnings as errors in
 * EXJavaScriptSerializable.mm. It also rejects Sentry XCFramework headers as
 * non-modular when compiling RNSentry. Scope each setting to its affected pod.
 */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const POST_INSTALL_MARKER = "[with-ios-pod-settings] ExpoModulesCore return-type workaround";
const LEGACY_SENTRY_PREAMBLE =
  /^# \[with-ios-pod-settings\] Use one source-built Sentry Cocoa pod\nENV\['SENTRY_USE_XCFRAMEWORK'\] = '0'\n?/m;

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
  "      if target.name == 'RNSentry'",
  "        target.build_configurations.each do |config|",
  "          config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'",
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
      podfile = podfile.replace(LEGACY_SENTRY_PREAMBLE, "");

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
