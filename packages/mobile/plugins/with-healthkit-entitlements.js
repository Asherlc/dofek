const { withEntitlementsPlist } = require("@expo/config-plugins");

const REQUIRED_ENTITLEMENTS = {
  "com.apple.developer.healthkit": true,
  "com.apple.developer.healthkit.background-delivery": true,
  "com.apple.developer.healthkit.access": true,
};

function mergeHealthKitEntitlements(existing) {
  const safeExisting =
    typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {};
  return {
    ...safeExisting,
    ...REQUIRED_ENTITLEMENTS,
  };
}

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withHealthKitEntitlements(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults = mergeHealthKitEntitlements(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withHealthKitEntitlements;
module.exports.mergeHealthKitEntitlements = mergeHealthKitEntitlements;
