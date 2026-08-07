import { execFileSync } from "node:child_process";
import { appendFileSync, globSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const outputNames = [
  "analytics",
  "docker_ml",
  "docker_server",
  "e2e_web",
  "ml",
  "mobile",
  "storybook_mobile",
  "storybook_web",
  "terraform",
  "web",
  "zepp",
] as const;

const workspaceSchema = z.object({
  packages: z.array(z.string()).min(1),
});

const dependencySectionSchema = z.record(z.string(), z.string()).optional();
const packageManifestSchema = z.object({
  name: z.string().min(1),
  dependencies: dependencySectionSchema,
  optionalDependencies: dependencySectionSchema,
  peerDependencies: dependencySectionSchema,
});

interface DetectorOptions {
  all: boolean;
  changedFiles: string[];
  diffRange?: string;
  json: boolean;
  workspaceDirectory: string;
}

interface WorkspaceProject {
  dependencies: Set<string>;
  directory: string;
  name: string;
}

type ChangeOutputs = Record<(typeof outputNames)[number], boolean>;

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/").replace(/^\.\//, "");
}

function parseOptions(argumentsToParse: string[]): DetectorOptions {
  const options: DetectorOptions = {
    all: false,
    changedFiles: [],
    json: false,
    workspaceDirectory: resolve("."),
  };

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === "--all") {
      options.all = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (
      argument === "--changed-file" ||
      argument === "--diff-range" ||
      argument === "--workspace"
    ) {
      const value = argumentsToParse[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--changed-file") {
        options.changedFiles.push(normalizePath(value));
      } else if (argument === "--diff-range") {
        options.diffRange = value;
      } else {
        options.workspaceDirectory = resolve(value);
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.all && (options.changedFiles.length > 0 || options.diffRange !== undefined)) {
    throw new Error("--all cannot be combined with changed-file inputs");
  }
  if (options.diffRange !== undefined && options.changedFiles.length > 0) {
    throw new Error("--diff-range cannot be combined with --changed-file");
  }

  return options;
}

function readWorkspaceProjects(workspaceDirectory: string): WorkspaceProject[] {
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

  const manifests = [...manifestPaths].map((manifestPath) => {
    const manifestText = readFileSync(resolve(workspaceDirectory, manifestPath), "utf8");
    const parsedManifest: unknown = JSON.parse(manifestText);
    return {
      directory: normalizePath(dirname(manifestPath)),
      manifest: packageManifestSchema.parse(parsedManifest),
    };
  });
  const workspacePackageNames = new Set(manifests.map(({ manifest }) => manifest.name));

  return manifests.map(({ directory, manifest }) => {
    const dependencyEntries = [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.optionalDependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {}),
    ];
    return {
      dependencies: new Set(
        dependencyEntries
          .filter(
            ([dependencyName, version]) =>
              version.startsWith("workspace:") && workspacePackageNames.has(dependencyName),
          )
          .map(([dependencyName]) => dependencyName),
      ),
      directory,
      name: manifest.name,
    };
  });
}

function changedFilesFromDiff(workspaceDirectory: string, diffRange: string): string[] {
  const output = execFileSync("git", ["diff", "--name-only", diffRange], {
    cwd: workspaceDirectory,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map(normalizePath)
    .filter((filePath) => filePath.length > 0);
}

function findAffectedPackages(changedFiles: string[], projects: WorkspaceProject[]): Set<string> {
  const nestedProjects = projects
    .filter((project) => project.directory !== ".")
    .sort((left, right) => right.directory.length - left.directory.length);
  const rootProject = projects.find((project) => project.directory === ".");
  const affectedPackages = new Set<string>();

  for (const changedFile of changedFiles) {
    const nestedProject = nestedProjects.find(
      (project) =>
        changedFile === `${project.directory}/package.json` ||
        changedFile.startsWith(`${project.directory}/`),
    );
    if (nestedProject !== undefined) {
      affectedPackages.add(nestedProject.name);
    } else if (rootProject !== undefined && changedFile.startsWith("src/")) {
      affectedPackages.add(rootProject.name);
    }
  }

  let addedDependent = true;
  while (addedDependent) {
    addedDependent = false;
    for (const project of projects) {
      if (
        !affectedPackages.has(project.name) &&
        [...project.dependencies].some((dependencyName) => affectedPackages.has(dependencyName))
      ) {
        affectedPackages.add(project.name);
        addedDependent = true;
      }
    }
  }

  return affectedPackages;
}

function hasMatchingFile(changedFiles: string[], pattern: RegExp): boolean {
  return changedFiles.some((changedFile) => pattern.test(changedFile));
}

function classifyChanges(
  changedFiles: string[],
  projects: WorkspaceProject[],
  runAll: boolean,
): ChangeOutputs {
  const criticalCiChange = hasMatchingFile(
    changedFiles,
    /^(?:\.github\/workflows\/(?:ci|test|detect-changes)\.yml|\.github\/actions\/|scripts\/detect-ci-changes\.ts$)/,
  );
  if (runAll || criticalCiChange) {
    return {
      analytics: true,
      docker_ml: true,
      docker_server: true,
      e2e_web: true,
      ml: true,
      mobile: true,
      storybook_mobile: true,
      storybook_web: true,
      terraform: true,
      web: true,
      zepp: true,
    };
  }

  const affectedPackages = findAffectedPackages(changedFiles, projects);
  const globalPackageChange = hasMatchingFile(
    changedFiles,
    /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/,
  );
  const analyticsChange =
    globalPackageChange ||
    hasMatchingFile(
      changedFiles,
      /^(?:analytics\/|src\/db\/clickhouse-sql\/|scripts\/migration-policy\.ts$|\.sqlfluff)/,
    );
  const serverChange =
    affectedPackages.has("dofek") ||
    affectedPackages.has("dofek-server") ||
    globalPackageChange ||
    hasMatchingFile(
      changedFiles,
      /^(?:analytics\/|drizzle\/|Dockerfile$|entrypoint\.sh$|\.github\/workflows\/build-docker\.yml$)/,
    );
  const webChange =
    affectedPackages.has("dofek-web") ||
    globalPackageChange ||
    hasMatchingFile(
      changedFiles,
      /^(?:analytics\/|drizzle\/|\.github\/workflows\/build-web\.yml$)/,
    );
  const mobileChange =
    affectedPackages.has("dofek-mobile") ||
    globalPackageChange ||
    hasMatchingFile(changedFiles, /^\.github\/workflows\/build-mobile\.yml$/);
  const zeppChange =
    affectedPackages.has("@dofek/zepp") ||
    globalPackageChange ||
    hasMatchingFile(
      changedFiles,
      /^(?:packages\/zepp-client\/|\.github\/actions\/build-zepp\/|\.github\/workflows\/build-zepp\.yml$)/,
    );
  const sharedStorybookChange = hasMatchingFile(
    changedFiles,
    /^(?:\.storybook\/|\.github\/workflows\/storybook-preview\.yml$)/,
  );
  const mlChange = hasMatchingFile(changedFiles, /^packages\/ml\//);

  return {
    analytics: analyticsChange,
    docker_ml:
      mlChange || hasMatchingFile(changedFiles, /^\.github\/workflows\/build-docker-ml\.yml$/),
    docker_server: serverChange,
    e2e_web:
      serverChange ||
      webChange ||
      hasMatchingFile(changedFiles, /^(?:cypress\/|docker-compose\.e2e\.yml$)/),
    ml: mlChange,
    mobile: mobileChange,
    storybook_mobile:
      mobileChange ||
      sharedStorybookChange ||
      hasMatchingFile(changedFiles, /^\.github\/workflows\/build-storybook-mobile\.yml$/),
    storybook_web:
      webChange ||
      sharedStorybookChange ||
      hasMatchingFile(changedFiles, /^\.github\/workflows\/build-storybook\.yml$/),
    terraform: hasMatchingFile(
      changedFiles,
      /^(?:deploy\/|\.github\/workflows\/deploy-terraform\.yml$)/,
    ),
    web: webChange,
    zepp: zeppChange,
  };
}

function writeOutputs(outputs: ChangeOutputs, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(outputs));
    return;
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  for (const outputName of outputNames) {
    const outputLine = `${outputName}=${outputs[outputName]}`;
    console.log(outputLine);
    if (githubOutput !== undefined) {
      appendFileSync(githubOutput, `${outputLine}\n`);
    }
  }
}

const options = parseOptions(process.argv.slice(2));
const changedFiles =
  options.diffRange === undefined
    ? options.changedFiles
    : changedFilesFromDiff(options.workspaceDirectory, options.diffRange);
const projects = readWorkspaceProjects(options.workspaceDirectory);
const outputs = classifyChanges(changedFiles, projects, options.all);

writeOutputs(outputs, options.json);
