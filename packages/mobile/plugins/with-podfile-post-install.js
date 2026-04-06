/**
 * Expo config plugin that modifies the generated Podfile.
 *
 * Handles two workarounds that cannot be expressed via expo-build-properties:
 *
 * 1. RNSentry header search path — the prebuilt Sentry XCFramework places
 *    private headers at native/sentry-pod/Sources/Sentry/include/ instead of
 *    the PODS_ROOT/Sentry/Sources/Sentry/include/ that RNSentry expects.
 *
 * 2. ExpoModulesCore -Wreturn-type — Xcode 26+ triggers -Werror,-Wreturn-type
 *    in ExpoModulesCore Worklets code when react-native-reanimated is installed.
 *    Downgrade the warning to non-fatal until the upstream fix lands.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

// Marker comment used to detect if the snippet has already been inserted.
const MARKER = "[with-podfile-post-install]";

// Use concatenation to avoid JS interpreting Ruby's ${PODS_ROOT} as a template expression.
const PODS_ROOT_REF = "${PODS_ROOT}";

const POST_INSTALL_SNIPPET = [
  "",
  "    # " + MARKER + " RNSentry header search path for prebuilt XCFramework",
  "    local_sentry_headers = '\"" +
    PODS_ROOT_REF +
    "/../native/sentry-pod/Sources/Sentry/include\"'",
  "    installer.pods_project.targets.each do |target|",
  "      if target.name == 'RNSentry'",
  "        target.build_configurations.each do |config|",
  "          paths = config.build_settings['HEADER_SEARCH_PATHS'] || '$(inherited)'",
  "          config.build_settings['HEADER_SEARCH_PATHS'] = paths + ' ' + local_sentry_headers",
  "        end",
  "      end",
  "",
  "      # " + MARKER + " ExpoModulesCore Xcode 26+ warning workaround",
  "      if target.name == 'ExpoModulesCore'",
  "        target.build_configurations.each do |config|",
  "          flags = config.build_settings['OTHER_CPLUSPLUSFLAGS'] || ['$(inherited)']",
  "          flags = [flags] if flags.is_a?(String)",
  "          flags << '-Wno-error=return-type'",
  "          config.build_settings['OTHER_CPLUSPLUSFLAGS'] = flags",
  "        end",
  "      end",
  "    end",
].join("\n");

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withPodfilePostInstall(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, "Podfile");
      let podfile = fs.readFileSync(podfilePath, "utf-8");

      // Skip if already injected (idempotent for non-clean prebuilds).
      if (podfile.includes(MARKER)) {
        return modConfig;
      }

      // Insert our hooks inside the existing post_install block, just before
      // the closing `end` of the block.
      const postInstallEndPattern = /(post_install\s+do\s+\|installer\|[\s\S]*?)(^\s*end\s*$)/m;
      const match = podfile.match(postInstallEndPattern);
      if (match) {
        podfile = podfile.replace(postInstallEndPattern, "$1\n" + POST_INSTALL_SNIPPET + "\n$2");
      } else {
        // Fallback: append a standalone post_install block
        podfile += "\n\npost_install do |installer|\n" + POST_INSTALL_SNIPPET + "\nend\n";
      }

      fs.writeFileSync(podfilePath, podfile);
      return modConfig;
    },
  ]);
}

module.exports = withPodfilePostInstall;
