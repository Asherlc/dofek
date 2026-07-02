#!/usr/bin/env -S pnpm tsx

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface GitHubIssue {
  number: number;
  title: string;
  url: string;
}

interface Options {
  dryRun: boolean;
  issueRefs: string[];
  limit: number;
  repoRoot: string | undefined;
  search: string | undefined;
  state: string;
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string; status?: number };
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    const message = err.message ?? "Unknown error";
    console.error(
      [
        "Error: Failed to run external command.",
        `  Command: ${command} ${args.join(" ")}`,
        `  Message: ${message}`,
        ...(stderr ? [`  stderr: ${stderr}`] : []),
      ].join("\n"),
    );
    throw new Error(message);
  }
}

function usage(): never {
  console.error(`Usage:
  pnpm tsx open-conductor-issue-workspaces.ts [issue-number-or-url ...]
  pnpm tsx open-conductor-issue-workspaces.ts --limit 10
  pnpm tsx open-conductor-issue-workspaces.ts --search "label:loading-perf state:open" --limit 20

Options:
  --dry-run             Print Conductor URLs without opening them
  --limit <number>      Number of issues to list when no issue refs are provided (default: 10)
  --repo-root <path>    Explicit repository root to pass to Conductor
  --search <query>      GitHub issue search query
  --state <state>       Issue state for gh issue list (default: open)`);
  process.exit(2);
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    dryRun: false,
    issueRefs: [],
    limit: 10,
    repoRoot: undefined,
    search: undefined,
    state: "open",
  };

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--limit") {
      const rawLimit = args[argumentIndex + 1];
      if (!rawLimit) usage();
      options.limit = Number.parseInt(rawLimit, 10);
      argumentIndex += 1;
    } else if (argument === "--repo-root") {
      const repoRoot = args[argumentIndex + 1];
      if (!repoRoot) usage();
      options.repoRoot = resolve(repoRoot.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
      argumentIndex += 1;
    } else if (argument === "--search") {
      const search = args[argumentIndex + 1];
      if (!search) usage();
      options.search = search;
      argumentIndex += 1;
    } else if (argument === "--state") {
      const state = args[argumentIndex + 1];
      if (!state) usage();
      options.state = state;
      argumentIndex += 1;
    } else if (argument === "--help" || argument === "-h") {
      usage();
    } else if (argument.startsWith("--")) {
      console.error(`Unknown option: ${argument}`);
      usage();
    } else {
      options.issueRefs.push(argument);
    }
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    console.error("--limit must be a positive number");
    process.exit(2);
  }

  return options;
}

function isGitHubIssue(value: unknown): value is GitHubIssue {
  if (typeof value !== "object" || value === null) return false;
  if (!("number" in value) || !("title" in value) || !("url" in value)) return false;
  return (
    typeof value.number === "number" &&
    typeof value.title === "string" &&
    typeof value.url === "string"
  );
}

function parseIssueArray(rawJson: string): GitHubIssue[] {
  let parsedIssues: unknown;
  try {
    parsedIssues = JSON.parse(rawJson);
  } catch {
    const preview = rawJson.length > 200 ? `${rawJson.slice(0, 200)}...` : rawJson;
    throw new Error(
      `Failed to parse GitHub CLI JSON output for issues. The output was not valid JSON. Raw output preview: ${preview}`,
    );
  }
  if (!Array.isArray(parsedIssues) || !parsedIssues.every(isGitHubIssue)) {
    throw new Error("GitHub CLI returned an unexpected issue list shape");
  }
  return parsedIssues;
}

function parseIssue(rawJson: string): GitHubIssue {
  let parsedIssue: unknown;
  try {
    parsedIssue = JSON.parse(rawJson);
  } catch {
    const preview = rawJson.length > 200 ? `${rawJson.slice(0, 200)}...` : rawJson;
    throw new Error(
      `Failed to parse GitHub CLI JSON output for issue. The output was not valid JSON. Raw output preview: ${preview}`,
    );
  }
  if (!isGitHubIssue(parsedIssue)) {
    throw new Error("GitHub CLI returned an unexpected issue shape");
  }
  return parsedIssue;
}

function findMainWorktreeRoot(): string {
  const worktreeList = run("git", ["worktree", "list", "--porcelain"]);
  const firstWorktreeLine = worktreeList
    .split("\n")
    .find((line) => line.startsWith("worktree "));
  if (!firstWorktreeLine) {
    return run("git", ["rev-parse", "--show-toplevel"]);
  }
  return firstWorktreeLine.slice("worktree ".length);
}

function loadIssues(options: Options): GitHubIssue[] {
  if (options.issueRefs.length > 0) {
    const issues: GitHubIssue[] = [];
    for (const issueRef of options.issueRefs) {
      try {
        issues.push(parseIssue(run("gh", ["issue", "view", issueRef, "--json", "number,title,url"])));
      } catch (error) {
        console.error(`Skipping invalid issue ref: ${issueRef} — ${(error as Error).message}`);
      }
    }
    return issues;
  }

  const listArgs = [
    "issue",
    "list",
    "--json",
    "number,title,url",
    "--limit",
    String(options.limit),
  ];
  if (options.search) {
    listArgs.push("--search", options.search);
  } else {
    listArgs.push("--state", options.state);
  }

  return parseIssueArray(run("gh", listArgs));
}

function conductorUrlFor(issue: GitHubIssue, repoRoot: string): string {
  const prompt = `Address this GitHub issue: ${issue.url}

#${issue.number}: ${issue.title}`;
  return `conductor://prompt=${encodeURIComponent(prompt)}&path=${encodeURIComponent(repoRoot)}`;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const repoRoot = options.repoRoot ?? findMainWorktreeRoot();

  if (!existsSync(repoRoot)) {
    console.error(`Repo root does not exist: ${repoRoot}`);
    process.exit(1);
  }

  const issues = loadIssues(options);
  if (issues.length === 0) {
    console.log("No matching issues found.");
    return;
  }

  console.log(`Using repo root: ${repoRoot}`);
  for (const issue of issues) {
    const conductorUrl = conductorUrlFor(issue, repoRoot);
    console.log(`Opening Conductor workspace for #${issue.number}: ${issue.title}`);
    if (options.dryRun) {
      console.log(conductorUrl);
    } else {
      execFileSync("open", [conductorUrl], { stdio: "ignore" });
    }
  }
}

main();
