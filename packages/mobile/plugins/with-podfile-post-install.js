/**
 * Expo config plugin that modifies the generated Podfile.
 *
 * Xcode 26+ treats ExpoModulesCore Worklets return-type warnings as errors in
 * EXJavaScriptSerializable.mm. Downgrade that warning until upstream resolves it.
 */
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "[with-podfile-post-install] ExpoModulesCore return-type workaround";

const POST_INSTALL_SNIPPET = [
  "",
  `    # ${MARKER}`,
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
function withPodfilePostInstall(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, "Podfile");
      let podfile = fs.readFileSync(podfilePath, "utf-8");

      if (podfile.includes(MARKER)) {
        return modConfig;
      }

      const postInstallEndPattern = /(post_install\s+do\s+\|installer\|[\s\S]*?)(^\s*end\s*$)/m;
      if (postInstallEndPattern.test(podfile)) {
        podfile = podfile.replace(postInstallEndPattern, `$1\n${POST_INSTALL_SNIPPET}\n$2`);
      } else {
        podfile += `\n\npost_install do |installer|\n${POST_INSTALL_SNIPPET}\nend\n`;
      }

      fs.writeFileSync(podfilePath, podfile);
      return modConfig;
    },
  ]);
}

module.exports = withPodfilePostInstall;
