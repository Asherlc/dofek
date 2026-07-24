import { spawnSync } from "node:child_process";

function runScript(script: string): number {
  const result = spawnSync("pnpm", [script], { stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to start pnpm ${script}: ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    console.error(`pnpm ${script} terminated by signal ${result.signal ?? "unknown"}`);
    return 1;
  }
  return result.status;
}

let firstStatus = runScript("e2e:web:up");
if (firstStatus === 0) {
  firstStatus = runScript("e2e:web:run");
}

const teardownStatus = runScript("e2e:web:down");
process.exitCode = firstStatus === 0 ? teardownStatus : firstStatus;
