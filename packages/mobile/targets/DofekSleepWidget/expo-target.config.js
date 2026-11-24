/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => {
  const hostBundleId = config.ios?.bundleIdentifier || "com.dofek.app";
  return {
    type: "widget",
    name: "DofekSleepWidget",
    displayName: "Dofek Sleep",
    bundleIdentifier: ".sleep-widget",
    deploymentTarget: "16.4",
    frameworks: ["SwiftUI", "WidgetKit"],
    entitlements: {
      "com.apple.security.application-groups": [`group.${hostBundleId}.sleep-widget`],
      "com.apple.developer.default-data-protection": "NSFileProtectionComplete",
    },
  };
};
