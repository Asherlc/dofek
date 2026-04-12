/**
 * Expo config plugin that excludes non-compilable files from the DofekWatch
 * target's PBXFileSystemSynchronizedRootGroup.
 *
 * @bacons/apple-targets uses PBXFileSystemSynchronizedRootGroup which auto-
 * includes every file in targets/DofekWatch/. Test files (*.test.swift) import
 * XCTest which is unavailable in app targets, and pods.rb is a Ruby file that
 * shouldn't be compiled. This plugin adds them to membershipExceptions.
 *
 * Runs as a withDangerousMod finalizer that patches the pbxproj text after
 * @bacons/apple-targets has written it. To ensure correct ordering, this
 * plugin must be listed AFTER @bacons/apple-targets in app.json plugins.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/** @type {import('@expo/config-plugins').ConfigPlugin} */
function withWatchTargetExclusions(config) {
  return withDangerousMod(config, [
    "ios",
    (modConfig) => {
      // Schedule the pbxproj patch to run after all mods complete.
      // withDangerousMod runs before base mods (where @bacons/apple-targets
      // writes the pbxproj), so we defer our work to process.nextTick.
      const platformRoot = modConfig.modRequest.platformProjectRoot;
      const projectRoot = modConfig.modRequest.projectRoot;

      // Use a process exit hook to ensure we run after all mods.
      // This is a workaround for the mod ordering limitation.
      const pbxprojPath = path.join(platformRoot, "Dofek.xcodeproj", "project.pbxproj");
      const targetsDir = path.join(projectRoot, "targets", "DofekWatch");

      // Register a hook that patches the file after prebuild writes it
      const patchPbxproj = () => {
        if (!fs.existsSync(pbxprojPath) || !fs.existsSync(targetsDir)) {
          return;
        }

        const filesToExclude = [];
        for (const file of fs.readdirSync(targetsDir)) {
          if (file.endsWith(".test.swift") || file === "pods.rb") {
            filesToExclude.push(file);
          }
        }

        if (filesToExclude.length === 0) {
          return;
        }

        let pbxproj = fs.readFileSync(pbxprojPath, "utf-8");

        const exceptionSetPattern =
          /(\/\* DofekWatch \*\/;\s*membershipExceptions = \(\s*)([\s\S]*?)(\s*\);)/;
        const match = pbxproj.match(exceptionSetPattern);

        if (!match) {
          return;
        }

        const existingExceptions = match[2];
        const newExceptions = filesToExclude
          .filter((file) => !existingExceptions.includes(file))
          .map((file) => `\t\t\t\t"${file}",`)
          .join("\n");

        if (newExceptions) {
          pbxproj = pbxproj.replace(exceptionSetPattern, `$1$2\n${newExceptions}$3`);
          fs.writeFileSync(pbxprojPath, pbxproj);
        }
      };

      // Hook into process.on('beforeExit') to run after all async mods
      process.once("beforeExit", patchPbxproj);

      return modConfig;
    },
  ]);
}

module.exports = withWatchTargetExclusions;
