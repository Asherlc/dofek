import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const NON_VISUAL_COMPONENT_EXEMPTIONS = new Set([
  "DashboardLayoutProvider",
  "QueryErrorBoundary",
  "UnitProvider",
]);

export interface WebStoryCoverageResult {
  missingStories: string[];
  staleExemptions: string[];
  visualComponentCount: number;
}

function sourceComponentName(fileName: string): string | null {
  if (!fileName.endsWith(".tsx") || /\.(?:stories|test)\.tsx$/.test(fileName)) {
    return null;
  }
  return fileName.slice(0, -".tsx".length);
}

function storyComponentName(fileName: string): string | null {
  if (!fileName.endsWith(".stories.tsx")) {
    return null;
  }
  return fileName.slice(0, -".stories.tsx".length);
}

export function scanWebStoryCoverage(
  componentsDirectory: string,
  exemptions: ReadonlySet<string> = NON_VISUAL_COMPONENT_EXEMPTIONS,
): WebStoryCoverageResult {
  const componentNames = new Set<string>();
  const storyNames = new Set<string>();

  for (const entry of readdirSync(componentsDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const componentName = sourceComponentName(entry.name);
    if (componentName) {
      componentNames.add(componentName);
    }
    const storyName = storyComponentName(entry.name);
    if (storyName) {
      storyNames.add(storyName);
    }
  }

  const activeExemptions = new Set(
    [...exemptions].filter(
      (componentName) => componentNames.has(componentName) && !storyNames.has(componentName),
    ),
  );
  const staleExemptions = [...exemptions]
    .filter((componentName) => !activeExemptions.has(componentName))
    .sort();
  const missingStories = [...componentNames]
    .filter(
      (componentName) => !storyNames.has(componentName) && !activeExemptions.has(componentName),
    )
    .sort()
    .map((componentName) => `${componentName}.tsx`);

  return {
    missingStories,
    staleExemptions,
    visualComponentCount: componentNames.size - activeExemptions.size,
  };
}

function runCommandLine(): void {
  const componentsDirectory = path.resolve(process.argv[2] ?? "packages/web/src/components");
  const result = scanWebStoryCoverage(componentsDirectory);

  if (result.missingStories.length > 0) {
    console.error("Visual web components missing colocated stories:");
    for (const fileName of result.missingStories) {
      console.error(`- ${path.join(componentsDirectory, fileName)}`);
    }
  }

  if (result.staleExemptions.length > 0) {
    console.error("Stale non-visual Storybook exemptions:");
    for (const componentName of result.staleExemptions) {
      console.error(`- ${componentName}`);
    }
  }

  if (result.missingStories.length > 0 || result.staleExemptions.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `Web Storybook coverage policy passed for ${result.visualComponentCount} visual components and ${NON_VISUAL_COMPONENT_EXEMPTIONS.size} non-visual exemptions.`,
  );
}

const commandPath = process.argv[1];
if (commandPath && pathToFileURL(path.resolve(commandPath)).href === import.meta.url) {
  runCommandLine();
}
