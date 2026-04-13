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

/**
 * Merge required background modes into the existing array, deduplicating.
 * Validates that the input is an array of strings before spreading.
 * @param {unknown} existing - The current UIBackgroundModes value
 * @returns {string[]}
 */
function mergeBackgroundModes(existing) {
  const safe = Array.isArray(existing) ? existing.filter((mode) => typeof mode === "string") : [];
  return [...new Set([...safe, ...REQUIRED_MODES])];
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withBackgroundModes(config) {
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults.UIBackgroundModes = mergeBackgroundModes(
      modConfig.modResults.UIBackgroundModes,
    );
    return modConfig;
  });
}

module.exports = withBackgroundModes;
module.exports.mergeBackgroundModes = mergeBackgroundModes;
