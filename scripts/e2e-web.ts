import { spawnSync } from "node:child_process";

function runScript(script: string, args: string[] = []): number {
  const result = spawnSync("pnpm", [script, ...args], { stdio: "inherit" });
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
  const cypressArguments = process.argv[2] === "--" ? process.argv.slice(3) : process.argv.slice(2);
  firstStatus = runScript(
    "e2e:web:run",
    cypressArguments.length > 0 ? ["--", ...cypressArguments] : [],
  );
}

const teardownStatus = runScript("e2e:web:down");
if (teardownStatus !== 0) {
  console.error(`Teardown failed with status ${teardownStatus}`);
}
process.exitCode = firstStatus === 0 ? teardownStatus : firstStatus;
