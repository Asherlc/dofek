/**
 * Expo config plugin that generates an Xcode scheme for the DofekWatch target.
 *
 * @bacons/apple-targets creates the DofekWatch native target in the pbxproj
 * but does not generate a corresponding .xcscheme file. Without a scheme,
 * `xcodebuild -workspace ... -scheme DofekWatch` fails because workspace
 * builds require schemes (unlike project builds which can use -target).
 *
 * The watchOS CI build needs -workspace (not -project) because CocoaPods
 * dependencies (Sentry) require workspace-level framework resolution.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withWatchScheme(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const platformRoot = modConfig.modRequest.platformProjectRoot;

      // Read the pbxproj to find the DofekWatch target's BlueprintIdentifier
      const pbxprojPath = path.join(platformRoot, "Dofek.xcodeproj", "project.pbxproj");

      // Schedule scheme creation after @bacons/apple-targets writes the pbxproj
      process.once("beforeExit", () => {
        if (!fs.existsSync(pbxprojPath)) {
          return;
        }

        const pbxproj = fs.readFileSync(pbxprojPath, "utf-8");

        // Find the DofekWatch target UUID
        const targetMatch = pbxproj.match(
          /(\w+)\s+\/\*\s*DofekWatch\s*\*\/\s*=\s*\{\s*isa\s*=\s*PBXNativeTarget/,
        );
        if (!targetMatch) {
          return;
        }
        const targetId = targetMatch[1];

        const schemesDir = path.join(platformRoot, "Dofek.xcodeproj", "xcshareddata", "xcschemes");
        const schemePath = path.join(schemesDir, "DofekWatch.xcscheme");

        if (fs.existsSync(schemePath)) {
          return;
        }

        fs.mkdirSync(schemesDir, { recursive: true });

        const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${targetId}"
               BuildableName = "DofekWatch.app"
               BlueprintName = "DofekWatch"
               ReferencedContainer = "container:Dofek.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "${targetId}"
            BuildableName = "DofekWatch.app"
            BlueprintName = "DofekWatch"
            ReferencedContainer = "container:Dofek.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

        fs.writeFileSync(schemePath, scheme);
      });

      return modConfig;
    },
  ]);
}

module.exports = withWatchScheme;
