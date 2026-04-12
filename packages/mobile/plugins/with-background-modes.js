/**
 * Expo config plugin that ensures UIBackgroundModes contains all required
 * entries.
 *
 * The expo-location plugin with isIosBackgroundLocationEnabled replaces
 * UIBackgroundModes with ["location"], clobbering any modes set by the
 * base ios.backgroundModes config (e.g. bluetooth-central, fetch).
 * This plugin runs after expo-location and merges the missing modes back.
 */
const { withInfoPlist } = require("@expo/config-plugins");

const REQUIRED_MODES = ["bluetooth-central", "fetch", "location"];

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withBackgroundModes(config) {
  return withInfoPlist(config, (modConfig) => {
    const existing = modConfig.modResults.UIBackgroundModes ?? [];
    const merged = [...new Set([...existing, ...REQUIRED_MODES])];
    modConfig.modResults.UIBackgroundModes = merged;
    return modConfig;
  });
}

module.exports = withBackgroundModes;
