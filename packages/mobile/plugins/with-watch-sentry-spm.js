/**
 * Expo config plugin that links the watch-only Sentry SDK through SwiftPM.
 *
 * The iOS app uses the Sentry framework bundled by @sentry/react-native.
 * The watch extension is a separate executable, so it has its own Sentry
 * linkage and must not introduce the legacy CocoaPods source build.
 */
const { createRequire } = require("node:module");
const path = require("node:path");

const requireAppleTargets = createRequire(require.resolve("@bacons/apple-targets"));
const { withXcodeProjectBeta } = requireAppleTargets(
  path.join(path.dirname(require.resolve("@bacons/apple-targets")), "with-bacons-xcode"),
);
const {
  PBXBuildFile,
  PBXFrameworksBuildPhase,
  PBXNativeTarget,
  XCRemoteSwiftPackageReference,
  XCSwiftPackageProductDependency,
} = requireAppleTargets("@bacons/xcode");

const PACKAGE_URL = "https://github.com/getsentry/sentry-cocoa.git";
const PACKAGE_VERSION = "9.24.0";
const PRODUCT_NAME = "Sentry";
const TARGET_NAME = "DofekWatch";

function findWatchTarget(project) {
  const target = project.rootObject.props.targets.find(
    (candidate) => PBXNativeTarget.is(candidate) && candidate.props.name === TARGET_NAME,
  );
  if (!target) {
    throw new Error(`Unable to add Sentry Swift package: ${TARGET_NAME} target was not generated.`);
  }

  return target;
}

function addWatchSentryPackage(project) {
  const pbxProject = project.rootObject;
  const target = findWatchTarget(project);
  const remotePackage =
    [...project.values()].find(
      (candidate) =>
        XCRemoteSwiftPackageReference.is(candidate) &&
        candidate.props.repositoryURL === PACKAGE_URL,
    ) ??
    XCRemoteSwiftPackageReference.create(project, {
      repositoryURL: PACKAGE_URL,
      requirement: { kind: "exactVersion", version: PACKAGE_VERSION },
    });
  remotePackage.props.requirement = { kind: "exactVersion", version: PACKAGE_VERSION };

  pbxProject.props.packageReferences ??= [];
  if (!pbxProject.props.packageReferences.includes(remotePackage)) {
    pbxProject.props.packageReferences.push(remotePackage);
  }

  const product =
    [...project.values()].find(
      (candidate) =>
        XCSwiftPackageProductDependency.is(candidate) &&
        candidate.props.package === remotePackage &&
        candidate.props.productName === PRODUCT_NAME,
    ) ??
    XCSwiftPackageProductDependency.create(project, {
      package: remotePackage,
      productName: PRODUCT_NAME,
    });

  target.props.packageProductDependencies ??= [];
  if (!target.props.packageProductDependencies.includes(product)) {
    target.props.packageProductDependencies.push(product);
  }

  const frameworksPhase = target.props.buildPhases.find(PBXFrameworksBuildPhase.is);
  if (!frameworksPhase) {
    throw new Error(
      `Unable to add Sentry Swift package: ${TARGET_NAME} has no Frameworks build phase.`,
    );
  }

  if (!frameworksPhase.props.files.some((buildFile) => buildFile.props.productRef === product)) {
    frameworksPhase.props.files.push(PBXBuildFile.create(project, { productRef: product }));
  }
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withWatchSentrySpm(config) {
  return withXcodeProjectBeta(config, (modConfig) => {
    addWatchSentryPackage(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withWatchSentrySpm;
