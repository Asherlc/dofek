import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const REVIEW_SCENARIOS = [
  "conflicting-sources",
  "empty-data",
  "error",
  "partial-data",
  "processing",
  "stale-provider",
] as const;

type ReviewScenario = (typeof REVIEW_SCENARIOS)[number];

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".pnpm",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "storybook-static",
]);

export interface ReviewScenarioCoverageOptions {
  mobileStoriesDirectory: string;
  webStoriesDirectory: string;
}

export interface ReviewScenarioCoverageResult {
  missingMobileScenarios: ReviewScenario[];
  missingWebScenarios: ReviewScenario[];
  mobileScenarioCount: number;
  webScenarioCount: number;
}

function listStoryFiles(directory: string): string[] {
  const storyFiles: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        storyFiles.push(...listStoryFiles(entryPath));
      }
    } else if (entry.isFile() && entry.name.endsWith(".stories.tsx")) {
      storyFiles.push(entryPath);
    }
  }

  return storyFiles;
}

function propertyNameText(propertyName: ts.PropertyName): string | null {
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) {
    return propertyName.text;
  }
  return null;
}

function exportedStoryTagSets(sourceText: string, fileName: string): Set<string>[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const storyTagSets: Set<string>[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) {
        continue;
      }
      const tagsProperty = declaration.initializer.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && propertyNameText(property.name) === "tags",
      );
      if (!tagsProperty || !ts.isArrayLiteralExpression(tagsProperty.initializer)) {
        continue;
      }
      const tags = new Set<string>();
      for (const element of tagsProperty.initializer.elements) {
        if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
          tags.add(element.text);
        }
      }
      storyTagSets.push(tags);
    }
  }

  return storyTagSets;
}

function scenariosInDirectory(directory: string): Set<ReviewScenario> {
  const scenarios = new Set<ReviewScenario>();

  for (const storyFile of listStoryFiles(directory)) {
    const storyTagSets = exportedStoryTagSets(readFileSync(storyFile, "utf8"), storyFile);
    for (const tags of storyTagSets) {
      if (tags.has("review-scenario")) {
        for (const scenario of REVIEW_SCENARIOS) {
          if (tags.has(`review-scenario-${scenario}`)) {
            scenarios.add(scenario);
          }
        }
      }
    }
  }

  return scenarios;
}

export function scanReviewScenarioCoverage({
  mobileStoriesDirectory,
  webStoriesDirectory,
}: ReviewScenarioCoverageOptions): ReviewScenarioCoverageResult {
  const mobileScenarios = scenariosInDirectory(mobileStoriesDirectory);
  const webScenarios = scenariosInDirectory(webStoriesDirectory);

  return {
    missingMobileScenarios: REVIEW_SCENARIOS.filter((scenario) => !mobileScenarios.has(scenario)),
    missingWebScenarios: REVIEW_SCENARIOS.filter((scenario) => !webScenarios.has(scenario)),
    mobileScenarioCount: mobileScenarios.size,
    webScenarioCount: webScenarios.size,
  };
}

function reportMissingScenarios(platform: string, scenarios: readonly ReviewScenario[]): void {
  if (scenarios.length === 0) {
    return;
  }
  console.error(`${platform} Storybook is missing review scenarios:`);
  for (const scenario of scenarios) {
    console.error(`- ${scenario}`);
  }
}

function runCommandLine(): void {
  const webStoriesDirectory = path.resolve(process.argv[2] ?? "packages/web/src");
  const mobileStoriesDirectory = path.resolve(process.argv[3] ?? "packages/mobile");
  const result = scanReviewScenarioCoverage({
    mobileStoriesDirectory,
    webStoriesDirectory,
  });

  reportMissingScenarios("Web", result.missingWebScenarios);
  reportMissingScenarios("Mobile", result.missingMobileScenarios);

  if (result.missingWebScenarios.length > 0 || result.missingMobileScenarios.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `Review scenario coverage passed with ${result.webScenarioCount} web and ${result.mobileScenarioCount} mobile scenarios.`,
  );
}

const commandPath = process.argv[1];
if (commandPath && pathToFileURL(path.resolve(commandPath)).href === import.meta.url) {
  runCommandLine();
}
