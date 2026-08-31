const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const WEAR_INCLUDE = 'include(":DofekWear")';

function appendWearTargetToSettings(settings) {
  return settings.includes(WEAR_INCLUDE) ? settings : `${settings.trimEnd()}\n${WEAR_INCLUDE}\n`;
}

/** Copies the source-controlled Wear target into Expo's generated Android project. */
function withWearOsTarget(config) {
  return withDangerousMod(config, [
    "android",
    (modConfig) => {
      const source = path.join(modConfig.modRequest.projectRoot, "targets", "DofekWear");
      const destination = path.join(modConfig.modRequest.platformProjectRoot, "DofekWear");
      fs.cpSync(source, destination, { recursive: true, force: true });

      const settingsPath = path.join(modConfig.modRequest.platformProjectRoot, "settings.gradle");
      fs.writeFileSync(
        settingsPath,
        appendWearTargetToSettings(fs.readFileSync(settingsPath, "utf8")),
      );
      return modConfig;
    },
  ]);
}

module.exports = withWearOsTarget;
module.exports.appendWearTargetToSettings = appendWearTargetToSettings;
