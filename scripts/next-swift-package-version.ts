import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const repositoryArgument = process.argv[2];

if (!repositoryArgument) {
  throw new Error("Usage: pnpm tsx scripts/next-swift-package-version.ts <git-repository>");
}

const repository = path.resolve(repositoryArgument);

if (!statSync(repository).isDirectory()) {
  throw new Error(`Repository path is not a directory: ${repository}`);
}

execFileSync("git", ["-C", repository, "rev-parse", "--git-dir"], {
  stdio: "ignore",
});

const tags = execFileSync("git", ["-C", repository, "tag", "--list"], {
  encoding: "utf8",
})
  .split("\n")
  .map((tag) => tag.trim())
  .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag))
  .map((tag) => tag.split(".").map(Number))
  .sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = (right[index] ?? 0) - (left[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });

const latest = tags[0];
const next = latest ? `${latest[0]}.${latest[1]}.${(latest[2] ?? 0) + 1}` : "0.1.0";

process.stdout.write(`${next}\n`);
