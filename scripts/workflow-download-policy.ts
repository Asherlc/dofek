import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const immutableGitRefPattern = /^(?:[0-9a-f]{40}|v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i;
const githubUrlPattern = /https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/[^\s"'`<>)]+/g;

interface MutableGitRefDownload {
  filePath: string;
  lineNumber: number;
  reference: string;
  url: string;
}

function collectWorkflowFiles(targetPath: string): string[] {
  if (!statSync(targetPath).isDirectory()) {
    return targetPath.endsWith(".yml") || targetPath.endsWith(".yaml") ? [targetPath] : [];
  }

  return readdirSync(targetPath, { withFileTypes: true })
    .toSorted((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name))
    .flatMap((entry) => collectWorkflowFiles(path.join(targetPath, entry.name)));
}

function gitReferenceFromUrl(url: string): string | undefined {
  const parsedUrl = new URL(url);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);

  if (parsedUrl.hostname === "raw.githubusercontent.com") {
    return pathSegments[2];
  }

  if (
    parsedUrl.hostname === "github.com" &&
    (pathSegments[2] === "raw" || pathSegments[2] === "blob")
  ) {
    return pathSegments[3];
  }

  return undefined;
}

function findMutableGitRefDownloads(filePath: string): MutableGitRefDownload[] {
  const workflowText = readFileSync(filePath, "utf8");
  const findings: MutableGitRefDownload[] = [];

  for (const match of workflowText.matchAll(githubUrlPattern)) {
    const url = match[0];
    const reference = gitReferenceFromUrl(url);
    if (!reference || immutableGitRefPattern.test(reference)) {
      continue;
    }

    findings.push({
      filePath,
      lineNumber: workflowText.slice(0, match.index).split("\n").length,
      reference,
      url,
    });
  }

  return findings;
}

const targetPaths = process.argv.slice(2);
const workflowFiles = (
  targetPaths.length > 0 ? targetPaths : [".github/workflows", ".github/actions"]
).flatMap(collectWorkflowFiles);

if (workflowFiles.length === 0) {
  throw new Error("No GitHub workflow or action YAML files found to check");
}

const findings = workflowFiles.flatMap(findMutableGitRefDownloads);
if (findings.length > 0) {
  for (const finding of findings) {
    console.log(
      `${finding.filePath}:${finding.lineNumber}: mutable Git ref '${finding.reference}' in download URL: ${finding.url}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log("No mutable Git-ref downloads found");
}
