import { globSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const dependencySectionNames = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const workspaceSchema = z.object({
  packages: z.array(z.string()).min(1),
});

const dependencySectionSchema = z.record(z.string(), z.string()).optional();
const packageManifestSchema = z.object({
  dependencies: dependencySectionSchema,
  devDependencies: dependencySectionSchema,
  peerDependencies: dependencySectionSchema,
  optionalDependencies: dependencySectionSchema,
});

interface VersionRangeViolation {
  dependencyName: string;
  manifestPath: string;
  version: string;
}

function readWorkspaceManifestPaths(workspaceDirectory: string): string[] {
  const workspaceConfigurationText = readFileSync(
    resolve(workspaceDirectory, "pnpm-workspace.yaml"),
    "utf8",
  );
  const parsedWorkspaceConfiguration: unknown = parse(workspaceConfigurationText);
  const workspaceConfiguration = workspaceSchema.parse(parsedWorkspaceConfiguration);
  const excludedManifestPatterns = workspaceConfiguration.packages
    .filter((packagePattern) => packagePattern.startsWith("!"))
    .map((packagePattern) => `${packagePattern.slice(1).replace(/\/$/, "")}/package.json`);
  const manifestPaths = new Set<string>();

  for (const packagePattern of workspaceConfiguration.packages) {
    if (packagePattern.startsWith("!")) {
      continue;
    }
    const manifestPattern =
      packagePattern === "." ? "package.json" : `${packagePattern.replace(/\/$/, "")}/package.json`;
    for (const manifestPath of globSync(manifestPattern, {
      cwd: workspaceDirectory,
      exclude: excludedManifestPatterns,
    })) {
      manifestPaths.add(manifestPath);
    }
  }

  return [...manifestPaths].sort();
}

function findVersionRangeViolations(workspaceDirectory: string): VersionRangeViolation[] {
  const violations: VersionRangeViolation[] = [];

  for (const manifestPath of readWorkspaceManifestPaths(workspaceDirectory)) {
    const manifestText = readFileSync(resolve(workspaceDirectory, manifestPath), "utf8");
    const parsedManifest: unknown = JSON.parse(manifestText);
    const manifest = packageManifestSchema.parse(parsedManifest);

    for (const sectionName of dependencySectionNames) {
      for (const [dependencyName, version] of Object.entries(manifest[sectionName] ?? {})) {
        if (
          !version.startsWith("workspace:") &&
          (version.startsWith("^") || version.startsWith("~"))
        ) {
          violations.push({ dependencyName, manifestPath, version });
        }
      }
    }
  }

  return violations;
}

const workspaceDirectory = resolve(process.argv[2] ?? ".");
const violations = findVersionRangeViolations(workspaceDirectory);

if (violations.length === 0) {
  console.log("All dependency versions are exact.");
} else {
  const violationsByManifest = Map.groupBy(violations, (violation) => violation.manifestPath);
  for (const [manifestPath, manifestViolations] of violationsByManifest) {
    const relativeManifestPath = relative(
      workspaceDirectory,
      resolve(workspaceDirectory, manifestPath),
    );
    console.error(`ERROR: ${relativeManifestPath} has version ranges:`);
    for (const violation of manifestViolations) {
      console.error(`  ${violation.dependencyName}: ${violation.version}`);
    }
  }
  console.error("\nAll dependencies must use exact versions (no ^ or ~ prefixes).");
  console.error("Use 'pnpm add <pkg>' — .npmrc enforces save-exact=true.");
  process.exitCode = 1;
}
