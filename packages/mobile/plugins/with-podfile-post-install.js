/**
 * Expo config plugin that modifies the generated Podfile.
 *
 * Handles three modifications that cannot be expressed via expo-build-properties:
 *
 * 1. Platform scoping — moves the global `platform :ios` declaration inside the
 *    main app target block so it doesn't conflict with watchOS targets added by
 *    @bacons/apple-targets (CocoaPods issues #4201, #4703, #4856).
 *
 * 2. RNSentry header search path — the prebuilt Sentry XCFramework places
 *    private headers at native/sentry-pod/Sources/Sentry/include/ instead of
 *    the PODS_ROOT/Sentry/Sources/Sentry/include/ that RNSentry expects.
 *
 * 3. ExpoModulesCore -Wreturn-type — Xcode 26+ triggers -Werror,-Wreturn-type
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

/**
 * Move the global `platform :ios` declaration inside the main target block.
 *
 * Expo prebuild generates `platform :ios, '...'` at the top level of the
 * Podfile. When a watchOS target is added as a sibling (by @bacons/apple-targets),
 * CocoaPods inherits the global iOS platform for that target, causing resolution
 * failures. Moving the platform declaration inside the target block scopes it
 * correctly.
 */
function movePlatformInsideTarget(podfile) {
  // Match the global platform declaration (outside any target block)
  const platformMatch = podfile.match(/^(platform :ios, .+)$/m);
  if (!platformMatch) return podfile;

  const platformLine = platformMatch[1];

  // Remove it from the global scope
  podfile = podfile.replace(platformLine + "\n", "");

  // Insert it right after the main target's `do` line
  podfile = podfile.replace(/(target ['"]Dofek['"] do\n)/, "$1  " + platformLine + "\n");

  return podfile;
}

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

      // Move platform :ios inside the main target to avoid conflicting with
      // watchOS targets.
      podfile = movePlatformInsideTarget(podfile);

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
