const { withEntitlementsPlist, withXcodeProject } = require("@expo/config-plugins");

const REQUIRED_ENTITLEMENTS = {
  "com.apple.developer.healthkit": true,
  "com.apple.developer.healthkit.background-delivery": true,
};

const VERIFY_ENTITLEMENT_SCRIPT = `
# Verify HealthKit entitlement is present at build time.
# This catches missing entitlements before the app reaches a device,
# where the failure would be a confusing runtime error.
if [ -n "$CODE_SIGN_ENTITLEMENTS" ]; then
  ENTITLEMENTS_PATH="$PROJECT_DIR/$CODE_SIGN_ENTITLEMENTS"
  if [ -f "$ENTITLEMENTS_PATH" ]; then
    if ! /usr/libexec/PlistBuddy -c "Print :com.apple.developer.healthkit" "$ENTITLEMENTS_PATH" 2>/dev/null | grep -q "true"; then
      echo "error: HealthKit entitlement (com.apple.developer.healthkit) is missing from $ENTITLEMENTS_PATH."
      echo "error: Ensure the with-healthkit-entitlements Expo config plugin is listed in app.json plugins."
      exit 1
    fi
    if ! /usr/libexec/PlistBuddy -c "Print :com.apple.developer.healthkit.background-delivery" "$ENTITLEMENTS_PATH" 2>/dev/null | grep -q "true"; then
      echo "error: HealthKit background delivery entitlement is missing from $ENTITLEMENTS_PATH."
      echo "error: Ensure the with-healthkit-entitlements Expo config plugin is listed in app.json plugins."
      exit 1
    fi
  fi
fi
`.trim();

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
  // 1. Merge HealthKit entitlements into the entitlements plist
  config = withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults = mergeHealthKitEntitlements(modConfig.modResults);
    return modConfig;
  });

  // 2. Add a build phase that verifies entitlements at build time
  config = withXcodeProject(config, (modConfig) => {
    const project = modConfig.modResults;
    const targetUuid = project.getFirstTarget().uuid;
    project.addBuildPhase(
      [],
      "PBXShellScriptBuildPhase",
      "Verify HealthKit Entitlement",
      targetUuid,
      {
        shellPath: "/bin/sh",
        shellScript: VERIFY_ENTITLEMENT_SCRIPT,
      },
    );
    return modConfig;
  });

  return config;
}

module.exports = withHealthKitEntitlements;
module.exports.mergeHealthKitEntitlements = mergeHealthKitEntitlements;
module.exports.VERIFY_ENTITLEMENT_SCRIPT = VERIFY_ENTITLEMENT_SCRIPT;
