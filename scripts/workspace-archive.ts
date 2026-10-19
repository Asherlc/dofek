import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const workspaceDirectory = realpathSync(process.cwd());
const defaultComposeFiles = ["-f", "docker-compose.yml", "-f", "docker-compose.peerdb.yml"];
const projects = [
  defaultComposeFiles,
  ["--project-suffix", "e2e", "-f", "docker-compose.e2e.yml"],
  ["--project-suffix", "peerdb-integration", ...defaultComposeFiles],
];

for (const projectArguments of projects) {
  const arguments_ = [
    "compose",
    "--",
    ...projectArguments,
    "--profile",
    "*",
    "down",
    "--remove-orphans",
    "--volumes",
  ];
  const result = spawnSync("pnpm", arguments_, {
    cwd: workspaceDirectory,
    env: { ...process.env, PWD: workspaceDirectory },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const failure = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? "unknown"}`;
    throw new Error(`pnpm ${arguments_.join(" ")} exited with ${failure}`);
  }
}
