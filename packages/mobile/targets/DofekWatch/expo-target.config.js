const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "watch",
  name: "DofekWatch",
  bundleIdentifier: "com.dofek.app.watchkitapp",
  icon: "../../assets/icon.png",
  deploymentTarget: "10.0",
  frameworks: ["CoreMotion", "WatchConnectivity"],
  infoPlist: {
    NSMotionUsageDescription:
      "Dofek records accelerometer data to track your movement and activity throughout the day.",
    RCTNewArchEnabled: true,
    ...(sentryDsn ? { SentryDsn: sentryDsn } : {}),
    WKApplication: true,
    WKCompanionAppBundleIdentifier: "com.dofek.app",
  },
};
